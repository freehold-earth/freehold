package proxy

import (
	"bytes"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"math/big"
	"sync"

	"github.com/freehold-earth/freehold/internal/audit"
	"github.com/freehold-earth/freehold/internal/receipt"
	"github.com/freehold-earth/freehold/internal/spal"
)

// exchange is one request on its way through the proxy, and what the proxy owes its answer.
type exchange struct {
	// conditions is what the operator has committed to for the request. It is nil unless the request was made under
	// terms and accepted.
	conditions *spal.Conditions

	// id is the id of the request, or nil where it has none.
	id jsontext.Value

	// said is what the request said of its terms, or nil where it said nothing well formed.
	said *sent

	// method names what the request asks.
	method string

	// proxy is the proxy the request is passing through.
	proxy *Proxy

	// requestID is the operator's handle for an accepted request.
	requestID string

	// finished is whether the exchange has ended.
	finished bool

	// mu guards finished.
	mu sync.Mutex
}

// maxNumberBytes is the longest number an id is worked out from.
const maxNumberBytes = 64

// errAnsweredTwice is why a second response to one request is not passed on.
var errAnsweredTwice = errors.New("the server answered one request twice")

// advertise puts what the operator says of itself into a discovery result, under the terms extension.
func advertise(result map[string]jsontext.Value, advertised advertisement) error {
	capabilities := make(map[string]jsontext.Value)
	if written, ok := result[memberCapabilities]; ok {
		if written.Kind() != '{' || json.Unmarshal(written, &capabilities) != nil {
			return errors.New("the server's capabilities are not one JSON object")
		}
	}
	if err := setMember(capabilities, memberExtensions, extensionID, advertised); err != nil {
		return err
	}

	var err error
	result[memberCapabilities], err = json.Marshal(capabilities, json.Deterministic(true))

	return err
}

// committed returns what the server behind is told about an accepted request.
func (e *exchange) committed() commitment {
	return commitment{
		RequestID:        e.requestID,
		TermsHash:        hex.EncodeToString(e.said.termsHash[:]),
		ContextScope:     e.said.scope,
		Custody:          e.conditions.Custody,
		RetentionSeconds: e.conditions.RetentionSeconds,
		Training:         e.conditions.Training,
		Aggregation:      e.conditions.Aggregation,
		Resale:           e.conditions.Resale,
	}
}

// entry returns the audit line for an accepted request with the given outcome.
func (e *exchange) entry(outcome audit.Outcome) audit.Entry {
	return audit.Entry{
		Time:         e.proxy.now().UTC(),
		Outcome:      outcome,
		Method:       e.method,
		RequestID:    e.requestID,
		TermsHash:    hex.EncodeToString(e.said.termsHash[:]),
		Nonce:        hex.EncodeToString(e.said.nonce[:]),
		ContextScope: e.said.scope,
		Conditions:   e.conditions,
	}
}

// finish ends the exchange, and reports whether this call is the one that ended it: an exchange ends once. Ending an
// accepted request records how it ended, with the receipt where it was served.
func (e *exchange) finish(outcome audit.Outcome, signed *receipt.Receipt) bool {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.finished {
		return false
	}
	e.finished = true

	if e.conditions != nil {
		entry := e.entry(outcome)
		entry.Receipt = signed
		if err := e.proxy.audit.Record(entry); err != nil {
			// The accepted line already says what the operator took on. This one would have said how it ended.
			e.proxy.logger.Error("recording how a request ended", "outcome", outcome, "error", err)
		}
	}

	return true
}

// rewrite returns the JSON-RPC message from the server behind with what the proxy owes the client put in: the
// operator's tolerance in a discovery result, and a signed receipt in the result of an accepted request. A message
// that is not a response is returned as it came.
//
// The response ends the exchange: an accepted request is recorded as served, or as failed where the response is an
// error, which has nowhere to carry a receipt. It returns an error for a response to some other request, and for a
// second response to this one, so that one request never earns two receipts.
func (e *exchange) rewrite(message []byte) ([]byte, error) {
	var members map[string]jsontext.Value
	// What a decoder says is wrong can quote what it was reading, so it is not passed on.
	if jsontext.Value(message).Kind() != '{' || json.Unmarshal(message, &members) != nil {
		return nil, errors.New("the server's message is not one JSON object")
	}
	if _, ok := members[memberMethod]; ok {
		return message, nil
	}
	written, ok := members[memberResult]
	// An error may come without an id, where the server could not tell which request it was answering.
	if answered := members[memberID]; !sameID(answered, e.id) && (ok || answered.Kind() != 'n' && answered != nil) {
		return nil, errors.New("the server answered a request other than the one it was sent")
	}
	if !ok {
		if !e.finish(audit.OutcomeFailed, nil) {
			return nil, errAnsweredTwice
		}

		return message, nil
	}
	var result map[string]jsontext.Value
	if written.Kind() != '{' || json.Unmarshal(written, &result) != nil {
		return nil, errors.New("the server's result is not one JSON object")
	}

	if e.method == methodDiscover {
		if err := advertise(result, e.proxy.advertised); err != nil {
			return nil, err
		}
	}
	var signed *receipt.Receipt
	if e.conditions != nil {
		made, err := e.sign()
		if err != nil {
			return nil, err
		}
		if err := setMember(result, memberMeta, keyReceipt, made); err != nil {
			return nil, err
		}
		signed = &made
	}

	var err error
	if members[memberResult], err = json.Marshal(result, json.Deterministic(true)); err != nil {
		return nil, fmt.Errorf("encoding the server's result: %w", err)
	}
	rewritten, err := json.Marshal(members, json.Deterministic(true))
	if err != nil {
		return nil, fmt.Errorf("encoding the server's response: %w", err)
	}
	// The receipt leaves only with the request recorded as served, and only once.
	if !e.finish(audit.OutcomeServed, signed) {
		return nil, errAnsweredTwice
	}

	return rewritten, nil
}

// rewrites reports whether the proxy owes the answer to this request anything.
func (e *exchange) rewrites() bool {
	return e.conditions != nil || e.method == methodDiscover
}

// sameID reports whether two JSON-RPC ids are the same id, however each is written: the same text, or the same
// number to the last digit. Anything that is not text or a number is no id.
func sameID(a jsontext.Value, b jsontext.Value) bool {
	if a.Kind() != b.Kind() {
		return false
	}

	switch a.Kind() {
	case '"':
		var left, right string

		return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && left == right
	case '0':
		// Numbers are compared exactly, since no machine number holds every id. Only short numbers with no
		// exponent are worked out: the rest are the same id only where they are written the same.
		if len(a) > maxNumberBytes || len(b) > maxNumberBytes || bytes.ContainsAny(a, "eE") ||
			bytes.ContainsAny(b, "eE") {
			return bytes.Equal(a, b)
		}
		left, leftOK := new(big.Rat).SetString(string(a))
		right, rightOK := new(big.Rat).SetString(string(b))

		return leftOK && rightOK && left.Cmp(right) == 0
	default:
		return false
	}
}

// setMember sets object[name][key] to value, where object[name] is a JSON object or is not there yet.
func setMember(object map[string]jsontext.Value, name string, key string, value any) error {
	inner := make(map[string]jsontext.Value)
	if written, ok := object[name]; ok {
		if written.Kind() != '{' || json.Unmarshal(written, &inner) != nil {
			return fmt.Errorf("the server's %s is not one JSON object", name)
		}
	}

	var err error
	if inner[key], err = json.Marshal(value); err != nil {
		return err
	}
	object[name], err = json.Marshal(inner, json.Deterministic(true))

	return err
}

// sign returns the operator's receipt for an accepted request, served now.
func (e *exchange) sign() (receipt.Receipt, error) {
	signed, err := receipt.Sign(e.proxy.key, receipt.Statement{
		TermsHash:  e.said.termsHash,
		Nonce:      e.said.nonce,
		Commitment: e.said.commitment,
		RequestID:  e.requestID,
		ServedAt:   e.proxy.now(),
		Conditions: *e.conditions,
	})
	if err != nil {
		return receipt.Receipt{}, fmt.Errorf("signing a receipt: %w", err)
	}

	return signed, nil
}
