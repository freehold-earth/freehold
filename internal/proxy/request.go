package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"strings"

	"github.com/freehold-earth/freehold/internal/receipt"
)

const (
	// lowerHex is the set of lowercase hex digits.
	lowerHex = "0123456789abcdef"

	// maxIDDigits is the maximum number of digits in a numeric ID.
	maxIDDigits = 32

	// maxNameBytes is the maximum length of a method, scope or condition name.
	// Each name is written to the audit record as sent, so the limit keeps a name from carrying other content.
	maxNameBytes = 256

	// maxTermsBytes is the maximum size of terms.
	// Terms are typically a few hundred bytes.
	maxTermsBytes = 64 << 10
)

// label is the terms label of a request, as carried in the request's metadata.
// Its fields are in wire order.
type label struct {
	// TermsHash is the hash of the terms, in lowercase hex.
	TermsHash string `json:"terms_hash"`

	// ContextScope is the scope of the data the request carries.
	ContextScope string `json:"context_scope"`

	// Nonce is the client's nonce for the request, in lowercase hex.
	Nonce string `json:"nonce"`

	// Commitment is the client's commitment to the request, in lowercase hex.
	Commitment string `json:"commitment"`

	// Terms is the terms document, or empty when the client sent only the hash.
	Terms jsontext.Value `json:"terms,omitzero"`
}

// request is a parsed JSON-RPC request.
// Members the proxy does not read are kept as sent.
type request struct {
	// id is the ID of the request.
	// It is nil for a message that expects no response.
	id jsontext.Value

	// members maps each member name of the message to its raw value.
	members map[string]jsontext.Value

	// meta is the metadata in the parameters, or nil when there is none.
	meta map[string]jsontext.Value

	// method is the method of the request.
	method string

	// params is the parameters, or nil when they are not a JSON object.
	params map[string]jsontext.Value
}

// sent is a well-formed terms label with its hex values decoded.
type sent struct {
	// commitment is the client's commitment to the request.
	commitment [sha256.Size]byte

	// nonce is the client's nonce for the request.
	nonce [receipt.NonceSize]byte

	// scope is the scope of the data the request carries.
	scope string

	// terms is the terms document, or nil when the client sent only the hash.
	terms jsontext.Value

	// termsHash is the hash of the terms.
	termsHash [sha256.Size]byte
}

// parseRequest parses body as a JSON-RPC request.
// It returns an error when body is not one JSON object that holds a valid request.
func parseRequest(body []byte) (request, error) {
	var req request
	if err := json.Unmarshal(body, &req.members); err != nil {
		return request{}, fmt.Errorf("not one JSON object: %w", err)
	}
	if err := exactNames(req.members, memberID, memberMethod, memberParams, memberVersion); err != nil {
		return request{}, err
	}

	method, ok := req.members[memberMethod]
	if !ok {
		return request{}, errors.New("no method")
	}
	if err := json.Unmarshal(method, &req.method); err != nil {
		return request{}, errors.New("method is not text")
	}
	if len(req.method) > maxNameBytes {
		return request{}, fmt.Errorf("method is longer than %d bytes", maxNameBytes)
	}
	// A message with no ID expects no response.
	req.id = req.members[memberID]
	if req.id != nil && req.id.Kind() != '"' && !plainNumber(req.id) {
		return request{}, errors.New("id is neither text nor a whole number")
	}

	params, ok := req.members[memberParams]
	if !ok || params.Kind() != '{' {
		return req, nil
	}
	if err := json.Unmarshal(params, &req.params); err != nil {
		return request{}, fmt.Errorf("params: %w", err)
	}
	if err := exactNames(req.params, memberMeta); err != nil {
		return request{}, err
	}

	meta, ok := req.params[memberMeta]
	if !ok {
		return req, nil
	}
	if meta.Kind() != '{' {
		return request{}, errors.New("_meta is not a JSON object")
	}
	if err := json.Unmarshal(meta, &req.meta); err != nil {
		return request{}, fmt.Errorf("_meta: %w", err)
	}
	if err := exactNames(req.meta, keyCapabilities, keyCommitment, keyTerms); err != nil {
		return request{}, err
	}

	return req, nil
}

// decodeHex decodes text into dst.
// It returns an error that names the member name unless text is lowercase hex of exactly the length of dst.
func decodeHex(dst []byte, name string, text string) error {
	if len(text) != hex.EncodedLen(len(dst)) || strings.Trim(text, lowerHex) != "" {
		return fmt.Errorf("%s is not %d lowercase hex characters", name, hex.EncodedLen(len(dst)))
	}
	if _, err := hex.Decode(dst, []byte(text)); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}

	return nil
}

// encode returns the request as JSON, with the current content of its metadata.
func (r request) encode() ([]byte, error) {
	if r.meta != nil {
		meta, err := json.Marshal(r.meta, json.Deterministic(true))
		if err != nil {
			return nil, err
		}
		r.params[memberMeta] = meta

		params, err := json.Marshal(r.params, json.Deterministic(true))
		if err != nil {
			return nil, err
		}
		r.members[memberParams] = params
	}

	return json.Marshal(r.members, json.Deterministic(true))
}

// exactNames returns an error if object has a member whose name differs from one of names only in letter case.
// Some JSON readers match names without regard to case, so another reader could read such a message differently.
func exactNames(object map[string]jsontext.Value, names ...string) error {
	for member := range object {
		for _, name := range names {
			if member != name && strings.EqualFold(member, name) {
				return fmt.Errorf("a member is named %s in other letter case", name)
			}
		}
	}

	return nil
}

// listsExtension reports whether the client's capabilities in the request list the terms extension.
func (r request) listsExtension() bool {
	var capabilities struct {
		Extensions map[string]jsontext.Value `json:"extensions"`
	}
	written, ok := r.meta[keyCapabilities]
	if !ok || json.Unmarshal(written, &capabilities) != nil {
		return false
	}
	_, listed := capabilities.Extensions[extensionID]

	return listed
}

// plainNumber reports whether value is a JSON integer of at most maxIDDigits digits, with an optional minus sign.
// A fraction or an exponent is rejected because its value is costly to compute.
func plainNumber(value jsontext.Value) bool {
	digits := strings.TrimPrefix(string(value), "-")

	return value.Kind() == '0' && len(digits) <= maxIDDigits && strings.Trim(digits, "0123456789") == ""
}

// said returns the terms label of the request and reports whether the request has one.
// It returns an error when the label is not well formed.
func (r request) said() (sent, bool, error) {
	written, ok := r.meta[keyTerms]
	if !ok {
		return sent{}, false, nil
	}

	// The decoder's error can quote the request, so it is not returned.
	var l label
	if written.Kind() != '{' || json.Unmarshal(written, &l, json.RejectUnknownMembers(true)) != nil {
		return sent{}, true, errors.New("not an object of the members the extension names")
	}

	s := sent{scope: l.ContextScope, terms: l.Terms}
	if s.scope == "" || len(s.scope) > maxNameBytes {
		return sent{}, true, fmt.Errorf("context_scope is empty or longer than %d bytes", maxNameBytes)
	}
	if len(s.terms) > maxTermsBytes {
		return sent{}, true, fmt.Errorf("terms are larger than %d bytes", maxTermsBytes)
	}
	if err := decodeHex(s.termsHash[:], "terms_hash", l.TermsHash); err != nil {
		return sent{}, true, err
	}
	if err := decodeHex(s.nonce[:], "nonce", l.Nonce); err != nil {
		return sent{}, true, err
	}
	if err := decodeHex(s.commitment[:], "commitment", l.Commitment); err != nil {
		return sent{}, true, err
	}

	return s, true, nil
}

// withCommitment returns the request as JSON with committed in its metadata.
// NOTE: The request must have metadata.
func (r request) withCommitment(committed commitment) ([]byte, error) {
	encoded, err := json.Marshal(committed)
	if err != nil {
		return nil, err
	}
	r.meta[keyCommitment] = encoded

	return r.encode()
}
