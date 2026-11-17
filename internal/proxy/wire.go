package proxy

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"net/http"

	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

// The JSON-RPC error codes the proxy answers with.
const (
	// codeHeaderMismatch is MCP's code for a request whose headers and body disagree.
	codeHeaderMismatch = -32020

	// codeInternal is JSON-RPC's code for a failure inside the server.
	codeInternal = -32603

	// codeInvalidRequest is JSON-RPC's code for a message that is not a request.
	codeInvalidRequest = -32600

	// codeMissingCapability is MCP's code for a request that needs a capability its client did not declare.
	codeMissingCapability = -32021

	// codeParse is JSON-RPC's code for a message that is not JSON.
	codeParse = -32700

	// codeRefused is the code of a refusal under the terms extension. It says nothing more than that: the reason
	// is in the error's data.
	codeRefused = 4030
)

// The names the terms extension and MCP give the things the proxy reads and writes.
const (
	// extensionID is the identifier of the terms extension.
	extensionID = "earth.freehold/spal"

	// headerMethod is the HTTP header in which MCP repeats a request's method.
	headerMethod = "Mcp-Method"

	// keyCapabilities is the member of a request's metadata that holds the client's capabilities.
	keyCapabilities = "io.modelcontextprotocol/clientCapabilities"

	// keyCommitment is the member of a request's metadata in which the proxy tells the server behind it what the
	// operator has committed to for the request.
	keyCommitment = "earth.freehold/commitment"

	// keyReceipt is the member of a result's metadata that holds the signed receipt.
	keyReceipt = "earth.freehold/receipt"

	// keyRefusal is the member of an error's data that holds a refusal.
	keyRefusal = "earth.freehold/refusal"

	// keyTerms is the member of a request's metadata that says which terms the request is made under.
	keyTerms = "earth.freehold/terms"

	// memberCapabilities is the member of a discovery result that holds the server's capabilities.
	memberCapabilities = "capabilities"

	// memberExtensions is the member of a set of capabilities that holds the extensions.
	memberExtensions = "extensions"

	// memberID is the member of a request or a response that ties the two together.
	memberID = "id"

	// memberMeta is the member of a request's parameters, or of a result, that holds protocol metadata.
	memberMeta = "_meta"

	// memberMethod is the member of a request that names what is asked.
	memberMethod = "method"

	// memberParams is the member of a request that holds its parameters.
	memberParams = "params"

	// memberResult is the member of a response that holds its result.
	memberResult = "result"

	// memberVersion is the member of a message that says which JSON-RPC it is.
	memberVersion = "jsonrpc"

	// methodDiscover is the request by which a client learns what a server supports.
	methodDiscover = "server/discover"

	// termsOptional is the advertised setting of an operator that serves requests made without terms.
	termsOptional = "optional"

	// termsRequired is the advertised setting of an operator that serves no data-carrying request without terms.
	termsRequired = "required"
)

// unencodable is the response to a request whose own error response could not be encoded.
const unencodable = `{"jsonrpc":"2.0","error":{"code":-32603,"message":"internal error"}}`

// dataCarrying are the requests that bring an end-user's data to a server.
var dataCarrying = []string{"prompts/get", "resources/read", "tools/call"}

// advertisement is what an operator says of itself in a discovery result: who signs for it, and its tolerance.
type advertisement struct {
	// OperatorDID is the identity the operator signs receipts with.
	OperatorDID string `json:"operator_did"`

	// Custody is the custody level the operator runs at.
	Custody spal.Custody `json:"custody"`

	// RetentionMinSeconds is the shortest time the operator is able to keep what it is sent for.
	RetentionMinSeconds uint64 `json:"retention_min_seconds"`

	// Training is the least the terms must permit by way of training.
	Training spal.Training `json:"training"`

	// Aggregation is the least the terms must permit by way of aggregation.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale is the least the terms must permit by way of resale.
	Resale spal.Resale `json:"resale"`

	// Terms is whether the operator serves data-carrying requests made without terms: required or optional.
	Terms string `json:"terms"`
}

// commitment is what the proxy tells the server behind it about a request it passes on under terms: the conditions
// the operator is now bound by, and the names the request goes by in the operator's audit record.
type commitment struct {
	// RequestID is the operator's handle for the request.
	RequestID string `json:"request_id"`

	// TermsHash is the hash of the terms the request is made under, in lowercase hex.
	TermsHash string `json:"terms_hash"`

	// ContextScope is the scope of the data the request carries.
	ContextScope string `json:"context_scope"`

	// Custody is the custody level the operator runs at.
	Custody spal.Custody `json:"custody"`

	// RetentionSeconds is the longest the operator may keep what the request carries; zero is not at all.
	RetentionSeconds uint64 `json:"retention_seconds"`

	// Training is whether the operator may train models on what the request carries.
	Training spal.Training `json:"training"`

	// Aggregation is whether the operator may aggregate what the request carries.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale is whether the operator may sell on what the request carries.
	Resale spal.Resale `json:"resale"`
}

// refusal is a refusal as it travels in an error's data.
type refusal struct {
	// Reason is why the request is refused.
	Reason terms.Reason `json:"reason"`

	// Condition names what the refusal is about, for the reasons that name something.
	Condition string `json:"condition,omitzero"`

	// TermsHash is the hash of the terms the request named, for the reasons that concern particular terms.
	TermsHash string `json:"terms_hash,omitzero"`
}

// rpcError is the error of a JSON-RPC error response.
type rpcError struct {
	// Code is the kind of error.
	Code int `json:"code"`

	// Message describes the error for a person reading a log.
	Message string `json:"message"`

	// Data is what else the error carries, where it carries anything.
	Data any `json:"data,omitzero"`
}

// rpcResponse is a JSON-RPC error response.
type rpcResponse struct {
	// Version is the JSON-RPC version, always 2.0.
	Version string `json:"jsonrpc"`

	// ID is the id of the request answered. A request that had none gets a response without one.
	ID jsontext.Value `json:"id,omitzero"`

	// Error is the error.
	Error rpcError `json:"error"`
}

// writeError answers a request with a JSON-RPC error response under the given HTTP status. Where the response
// cannot be encoded it answers with an internal error instead, so that no request is answered with nothing.
func (p *Proxy) writeError(w http.ResponseWriter, status int, id jsontext.Value, rpcErr rpcError) {
	body, err := json.Marshal(rpcResponse{Version: "2.0", ID: id, Error: rpcErr})
	if err != nil {
		p.logger.Error("encoding an error response", "code", rpcErr.Code, "error", err)
		status = http.StatusInternalServerError
		body = []byte(unencodable)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// A write that fails means the client has gone, and there is nobody left to tell.
	_, _ = w.Write(body)
}
