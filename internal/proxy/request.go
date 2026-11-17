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
	// lowerHex are the digits of lowercase hex.
	lowerHex = "0123456789abcdef"

	// maxIDDigits is the most digits an id that is a number may have.
	maxIDDigits = 32

	// maxNameBytes is the longest method, scope or condition name the proxy takes. Each is written to the audit
	// record as it was sent, so none is allowed to be long enough to carry anything else.
	maxNameBytes = 256

	// maxTermsBytes is the largest terms the proxy takes. Terms are a few hundred bytes.
	maxTermsBytes = 64 << 10
)

// label is what a request says about the terms it is made under, as it travels in the request's metadata.
type label struct {
	// TermsHash is the hash of the terms, in lowercase hex.
	TermsHash string `json:"terms_hash"`

	// ContextScope is the scope of the data the request carries.
	ContextScope string `json:"context_scope"`

	// Nonce is the nonce the agent minted for the request, in lowercase hex.
	Nonce string `json:"nonce"`

	// Commitment is the agent's commitment to the request, in lowercase hex.
	Commitment string `json:"commitment"`

	// Terms is the terms themselves, where the agent sent them.
	Terms jsontext.Value `json:"terms,omitzero"`
}

// request is a JSON-RPC request taken apart as far as the proxy reads it. What the proxy does not read stays as it
// was sent.
type request struct {
	// id ties the response to the request. It is nil for a message that expects no response.
	id jsontext.Value

	// members are the members of the message.
	members map[string]jsontext.Value

	// meta is the metadata in the parameters, or nil where there is none.
	meta map[string]jsontext.Value

	// method names what is asked.
	method string

	// params are the parameters, or nil where they are not a JSON object.
	params map[string]jsontext.Value
}

// sent is a label that is well formed, with its hex read.
type sent struct {
	// commitment is the agent's commitment to the request.
	commitment [sha256.Size]byte

	// nonce is the nonce the agent minted for the request.
	nonce [receipt.NonceSize]byte

	// scope is the scope of the data the request carries.
	scope string

	// terms is the terms themselves, or nil where the agent sent only their hash.
	terms jsontext.Value

	// termsHash is the hash of the terms.
	termsHash [sha256.Size]byte
}

// parseRequest takes the JSON-RPC request in body apart. It returns an error for anything but one JSON object with
// a method that is text.
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
	// An id is text or a whole number. A message with none expects no response.
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

// decodeHex reads text into dst, and returns an error naming the member unless text is lowercase hex of exactly
// dst's length.
func decodeHex(dst []byte, name string, text string) error {
	if len(text) != hex.EncodedLen(len(dst)) || strings.Trim(text, lowerHex) != "" {
		return fmt.Errorf("%s is not %d lowercase hex characters", name, hex.EncodedLen(len(dst)))
	}
	if _, err := hex.Decode(dst, []byte(text)); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}

	return nil
}

// encode returns the request as JSON, with its metadata as it now stands.
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

// exactNames returns an error if object has a member whose name is one of names in other letter case.
//
// The proxy reads names exactly, and some JSON readers do not: a server that took "Method" for "method" would be
// answering a request the proxy never saw. Such a message is refused whole.
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

// listsExtension reports whether the request's client lists the terms extension among its capabilities.
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

// plainNumber reports whether value is a JSON number written as digits alone, with a sign at most, and few enough
// of them to be an id. A fraction or an exponent makes a number that is cheap to write and costly to work out.
func plainNumber(value jsontext.Value) bool {
	digits := strings.TrimPrefix(string(value), "-")

	return value.Kind() == '0' && len(digits) <= maxIDDigits && strings.Trim(digits, "0123456789") == ""
}

// said returns what the request says about its terms, read and checked for form, and whether it says anything.
//
// It returns an error if what the request says is not well formed: a member the extension does not name, a hash,
// nonce or commitment that is not lowercase hex of its length, a scope that is empty or longer than a name may be,
// or terms larger than terms are.
func (r request) said() (sent, bool, error) {
	written, ok := r.meta[keyTerms]
	if !ok {
		return sent{}, false, nil
	}

	// What a decoder says is wrong can quote what the request named a member, so it is not passed on.
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

// withCommitment returns the request as JSON with committed in its metadata, for the server behind to read.
func (r request) withCommitment(committed commitment) ([]byte, error) {
	encoded, err := json.Marshal(committed)
	if err != nil {
		return nil, err
	}
	r.meta[keyCommitment] = encoded

	return r.encode()
}
