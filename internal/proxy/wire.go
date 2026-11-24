package proxy

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"net/http"

	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

// The JSON-RPC error codes of the proxy's responses.
const (
	// codeHeaderMismatch is the MCP code for a request whose headers and body disagree.
	codeHeaderMismatch = -32020

	// codeInternal is the JSON-RPC code for an internal error.
	codeInternal = -32603

	// codeInvalidRequest is the JSON-RPC code for a message that is not a request.
	codeInvalidRequest = -32600

	// codeMissingCapability is the MCP code for a request that needs a capability its client did not declare.
	codeMissingCapability = -32021

	// codeParse is the JSON-RPC code for a message that is not JSON.
	codeParse = -32700

	// codeRefused is the code of a refusal under the terms extension.
	// The reason for the refusal is in the error's data.
	codeRefused = 4030
)

// The names that the terms extension and MCP define.
const (
	// extensionID is the identifier of the terms extension.
	extensionID = "earth.freehold/spal"

	// headerMethod is the HTTP header in which MCP repeats the method of a request.
	headerMethod = "Mcp-Method"

	// keyCapabilities is the member of a request's metadata that holds the client's capabilities.
	keyCapabilities = "io.modelcontextprotocol/clientCapabilities"

	// keyCommitment is the member of a request's metadata that holds the operator's commitment for the request.
	keyCommitment = "earth.freehold/commitment"

	// keyReceipt is the member of a result's metadata that holds the signed receipt.
	keyReceipt = "earth.freehold/receipt"

	// keyRefusal is the member of an error's data that holds a refusal.
	keyRefusal = "earth.freehold/refusal"

	// keyTerms is the member of a request's metadata that holds the terms label.
	keyTerms = "earth.freehold/terms"

	// memberCapabilities is the member of a discovery result that holds the server's capabilities.
	memberCapabilities = "capabilities"

	// memberExtensions is the member of a capabilities object that holds the extensions.
	memberExtensions = "extensions"

	// memberID is the member of a request or a response that holds its ID.
	memberID = "id"

	// memberMeta is the member of a request's parameters, or of a result, that holds protocol metadata.
	memberMeta = "_meta"

	// memberMethod is the member of a request that holds its method.
	memberMethod = "method"

	// memberParams is the member of a request that holds its parameters.
	memberParams = "params"

	// memberResult is the member of a response that holds its result.
	memberResult = "result"

	// memberVersion is the member of a message that holds the JSON-RPC version.
	memberVersion = "jsonrpc"

	// methodDiscover is the method by which a client learns what a server supports.
	methodDiscover = "server/discover"

	// termsOptional is the advertised setting of an operator that serves requests made without terms.
	termsOptional = "optional"

	// termsRequired is the advertised setting of an operator that serves no data-carrying request without terms.
	termsRequired = "required"
)

// unencodable is the response to a request whose error response could not be encoded.
const unencodable = `{"jsonrpc":"2.0","error":{"code":-32603,"message":"internal error"}}`

// dataCarrying lists the methods that carry an end-user's data to a server.
var dataCarrying = []string{"prompts/get", "resources/read", "tools/call"}

// advertisement is the operator's entry in a discovery result: its identity and its tolerance.
// Its fields are in wire order.
type advertisement struct {
	// OperatorDID is the decentralized identifier (DID) the operator signs receipts with.
	OperatorDID string `json:"operator_did"`

	// Custody is the custody level the operator runs at.
	Custody spal.Custody `json:"custody"`

	// RetentionMinSeconds is the shortest retention period the operator can keep to, in seconds.
	RetentionMinSeconds uint64 `json:"retention_min_seconds"`

	// Training is the least the terms must permit for training.
	Training spal.Training `json:"training"`

	// Aggregation is the least the terms must permit for aggregation.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale is the least the terms must permit for resale.
	Resale spal.Resale `json:"resale"`

	// Terms is the advertised terms setting: termsRequired or termsOptional.
	Terms string `json:"terms"`
}

// commitment is the operator's commitment for a request made under terms, as carried in the request's metadata.
// It holds the conditions that bind the operator and the identifiers of the request in the audit record.
// Its fields are in wire order.
type commitment struct {
	// RequestID is the operator's ID for the request.
	RequestID string `json:"request_id"`

	// TermsHash is the hash of the terms the request is made under, in lowercase hex.
	TermsHash string `json:"terms_hash"`

	// ContextScope is the scope of the data the request carries.
	ContextScope string `json:"context_scope"`

	// Custody is the custody level the operator runs at.
	Custody spal.Custody `json:"custody"`

	// RetentionSeconds is the longest the operator may keep the request's data, in seconds.
	// Zero forbids retention.
	RetentionSeconds uint64 `json:"retention_seconds"`

	// Training states whether the operator may train models on the request's data.
	Training spal.Training `json:"training"`

	// Aggregation states whether the operator may aggregate the request's data.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale states whether the operator may resell the request's data.
	Resale spal.Resale `json:"resale"`
}

// refusal is a refusal as carried in an error's data.
// Its fields are in wire order.
type refusal struct {
	// Reason is the reason for the refusal.
	Reason terms.Reason `json:"reason"`

	// Condition is the name of the condition the refusal concerns, for the reasons that name one.
	Condition string `json:"condition,omitzero"`

	// TermsHash is the hash of the terms the request named, for the reasons that concern particular terms.
	TermsHash string `json:"terms_hash,omitzero"`
}

// rpcError is the error object of a JSON-RPC error response.
// Its fields are in wire order.
type rpcError struct {
	// Code is the error code.
	Code int `json:"code"`

	// Message is a short description of the error.
	Message string `json:"message"`

	// Data is the additional data of the error, or nil.
	Data any `json:"data,omitzero"`
}

// rpcResponse is a JSON-RPC error response.
// Its fields are in wire order.
type rpcResponse struct {
	// Version is the JSON-RPC version, always 2.0.
	Version string `json:"jsonrpc"`

	// ID is the ID of the request answered.
	// It is omitted for a request that had none.
	ID jsontext.Value `json:"id,omitzero"`

	// Error is the error object.
	Error rpcError `json:"error"`
}

// writeError writes a JSON-RPC error response with the given HTTP status.
// When the response cannot be encoded it writes an internal error response instead.
func (p *Proxy) writeError(w http.ResponseWriter, status int, id jsontext.Value, rpcErr rpcError) {
	body, err := json.Marshal(rpcResponse{Version: "2.0", ID: id, Error: rpcErr})
	if err != nil {
		p.logger.Error("encoding an error response", "code", rpcErr.Code, "error", err)
		status = http.StatusInternalServerError
		body = []byte(unencodable)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// A failed write means the client has disconnected, so the error has no recipient.
	_, _ = w.Write(body)
}
