package client

import (
	"encoding/hex"
	legacyjson "encoding/json"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/freehold-earth/freehold/internal/receipt"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

// The names that the terms extension and MCP define.
const (
	// extensionID is the identifier of the terms extension.
	extensionID = "earth.freehold/spal"

	// keyReceipt is the member of a result's metadata that holds the signed receipt.
	keyReceipt = "earth.freehold/receipt"

	// keyRefusal is the member of an error's data that holds a refusal.
	keyRefusal = "earth.freehold/refusal"

	// keyTerms is the member of a request's metadata that holds the terms label.
	keyTerms = "earth.freehold/terms"

	// memberMeta is the member of a request's parameters that holds protocol metadata.
	memberMeta = "_meta"

	// methodCallTool is the method that calls a tool.
	methodCallTool = "tools/call"

	// minProtocolVersion is the first version of MCP that has extensions.
	minProtocolVersion = "2026-07-28"
)

// advertisement is an operator's entry in a discovery result: its identity and its tolerance.
type advertisement struct {
	spal.Tolerance

	// OperatorDID is the decentralized identifier (DID) the operator signs receipts with.
	OperatorDID string `json:"operator_did"`
}

// label is the terms label of a request, as carried in the request's metadata.
// Its fields are in wire order.
type label struct {
	// TermsHash is the hash of the terms, in lowercase hex.
	TermsHash string `json:"terms_hash"`

	// ContextScope is the scope of the data the request carries.
	ContextScope string `json:"context_scope"`

	// Nonce is the nonce of the request, in lowercase hex.
	Nonce string `json:"nonce"`

	// Commitment is the commitment to the request, in lowercase hex.
	Commitment string `json:"commitment"`

	// Terms is the terms document, or empty when only the hash is sent.
	Terms jsontext.Value `json:"terms,omitzero"`
}

// newLabel returns the wire form of minted for a request about the data at scope.
// A non-empty written is sent as the terms document.
func newLabel(minted receipt.Label, scope string, written jsontext.Value) label {
	return label{
		TermsHash:    hex.EncodeToString(minted.TermsHash[:]),
		ContextScope: scope,
		Nonce:        hex.EncodeToString(minted.Nonce[:]),
		Commitment:   hex.EncodeToString(minted.Commitment[:]),
		Terms:        written,
	}
}

// readAdvertisement returns the advertisement for the terms extension in discovered, a server's discovery result.
// It returns ErrExtension when there is none, when its tolerance holds a value S-PAL does not allow,
// or when the server does not speak a version of MCP that has extensions.
func readAdvertisement(discovered *mcp.InitializeResult) (advertisement, error) {
	// A server on an older version is not told which extensions its client lists, so it applies no terms.
	if discovered == nil || discovered.Capabilities == nil || discovered.ProtocolVersion < minProtocolVersion {
		return advertisement{}, ErrExtension
	}
	listed, ok := discovered.Capabilities.Extensions[extensionID]
	if !ok {
		return advertisement{}, ErrExtension
	}

	var advertised advertisement
	encoded, err := legacyjson.Marshal(listed)
	if err == nil {
		err = json.Unmarshal(encoded, &advertised)
	}
	if err == nil {
		err = advertised.Validate()
	}
	if err != nil {
		return advertisement{}, fmt.Errorf("%w with a valid tolerance: %w", ErrExtension, err)
	}

	return advertised, nil
}

// refusalFrom returns the refusal that err carries, or nil when err is not a refusal under the terms extension.
func refusalFrom(err error) *Refusal {
	answered, ok := errors.AsType[*jsonrpc.Error](err)
	if !ok {
		return nil
	}

	var data map[string]jsontext.Value
	if json.Unmarshal(answered.Data, &data) != nil || data[keyRefusal] == nil {
		return nil
	}
	var refused Refusal
	var stated struct {
		Reason    terms.Reason `json:"reason"`
		Condition string       `json:"condition"`
	}
	if json.Unmarshal(data[keyRefusal], &stated) == nil && stated.Reason.Defined() {
		refused = Refusal{Condition: stated.Condition, Reason: stated.Reason}
	}

	return &refused
}

// requestBytes returns the bytes that the commitment covers for a request with method and params.
// They are the canonical JSON (RFC 8785) of the method and of the parameters without their metadata.
// NOTE: params must encode as a JSON object.
func requestBytes(method string, params any) ([]byte, error) {
	// The parameters are encoded as the MCP SDK encodes them, so the bytes match the request sent.
	encoded, err := legacyjson.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("encoding the parameters: %w", err)
	}
	var members map[string]jsontext.Value
	if err := json.Unmarshal(encoded, &members); err != nil {
		return nil, fmt.Errorf("the parameters are not a JSON object: %w", err)
	}
	delete(members, memberMeta)

	request, err := json.Marshal(map[string]any{"method": method, "params": members})
	if err != nil {
		return nil, fmt.Errorf("encoding the request: %w", err)
	}
	canonical := jsontext.Value(request)
	if err := canonical.Canonicalize(); err != nil {
		return nil, fmt.Errorf("encoding the request: %w", err)
	}

	return canonical, nil
}
