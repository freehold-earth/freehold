package receipt

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"slices"
	"sync/atomic"
	"time"

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/terms"
)

const (
	// AuditKeyMinBytes is the minimum length of an audit key.
	AuditKeyMinBytes = sha256.Size

	// ServedAtAllowance is the clock skew tolerated between an operator and an end-user.
	ServedAtAllowance = 5 * time.Minute
)

// Awaited verifies the one receipt expected for a labeled request.
// The zero value refuses every receipt.
// It is safe for concurrent use.
// NOTE: It is single-use: every call to Accept after the first fails with ReasonSpent.
type Awaited struct {
	// key is the operator's public key.
	key ed25519.PublicKey

	// label is the label of the request.
	label Label

	// labeledAt is the time the label was created.
	labeledAt time.Time

	// limits is the most the governing rule permits.
	limits terms.Limits

	// operator is the operator's DID.
	operator string

	// owed is true until the first call to Accept.
	owed atomic.Bool
}

// Label is the data that identifies one request in its receipt.
type Label struct {
	// Commitment is the keyed commitment to the request bytes.
	Commitment [sha256.Size]byte

	// Nonce is unique to the request.
	Nonce [NonceSize]byte

	// TermsHash is the hash of the terms.
	TermsHash [sha256.Size]byte
}

// Request describes a request made to an operator under an end-user's terms.
type Request struct {
	// Bytes is the request content that the commitment covers.
	Bytes []byte

	// Operator is the operator's DID.
	// NOTE: It must be a did:key that holds an Ed25519 key.
	Operator string

	// Scope is the scope of the data the request concerns.
	Scope string

	// Terms is the terms the request is made under.
	// NOTE: It must not be nil.
	Terms *terms.Terms
}

// Await creates the label for request and returns the Awaited that verifies its receipt.
// The commitment in the label is keyed with auditKey.
// It returns ErrAuditKey, ErrTerms, didkey.ErrNotEd25519 or a *terms.Refusal when the request cannot be labeled.
func Await(auditKey []byte, request Request) (*Awaited, error) {
	if len(auditKey) < AuditKeyMinBytes {
		return nil, fmt.Errorf("%w: want at least %d bytes, got %d", ErrAuditKey, AuditKeyMinBytes, len(auditKey))
	}
	if request.Terms == nil {
		return nil, ErrTerms
	}

	key, err := didkey.PublicKey(request.Operator)
	if err != nil {
		return nil, fmt.Errorf("operator: %w", err)
	}

	limits, err := request.Terms.Limits(request.Scope)
	if err != nil {
		return nil, err
	}

	awaited := &Awaited{
		key:       key,
		label:     Label{TermsHash: request.Terms.Hash()},
		labeledAt: time.Now(),
		limits:    limits,
		operator:  request.Operator,
	}
	// rand.Read never returns an error.
	rand.Read(awaited.label.Nonce[:])
	awaited.owed.Store(true)
	awaited.label.Commitment = commitment(auditKey, request.Operator, awaited.label.Nonce, request.Bytes)

	return awaited, nil
}

// Accept verifies presented as the receipt for the request and returns it.
// An empty presented means that no receipt was provided.
// A receipt that fails a check produces a *Refusal that names the first failed check.
func (a *Awaited) Accept(presented []byte) (Receipt, error) {
	presentedAt := time.Now()

	if !a.owed.CompareAndSwap(true, false) {
		return Receipt{}, &Refusal{Reason: ReasonSpent}
	}
	if len(presented) == 0 {
		return Receipt{}, &Refusal{Reason: ReasonMissing}
	}

	signed, err := read(presented)
	if err != nil {
		return Receipt{}, &Refusal{Reason: ReasonMalformed, cause: err}
	}
	if err := a.check(signed, presentedAt); err != nil {
		return Receipt{}, err
	}

	return signed.statement.receipt(signed.operator, signed.signature), nil
}

// Label returns the label of the request.
func (a *Awaited) Label() Label {
	return a.label
}

// check returns a *Refusal for the first check that signed fails, or nil.
func (a *Awaited) check(signed signedStatement, presentedAt time.Time) error {
	statement := signed.statement

	if signed.operator != a.operator {
		return &Refusal{Reason: ReasonOperator}
	}
	message, err := statement.signedBytes(signed.operator)
	if err != nil {
		return &Refusal{Reason: ReasonMalformed, cause: err}
	}
	if !ed25519.Verify(a.key, message, signed.signature) {
		return &Refusal{Reason: ReasonSignature}
	}

	switch {
	case statement.TermsHash != a.label.TermsHash:
		return &Refusal{Reason: ReasonTerms}
	case statement.Nonce != a.label.Nonce:
		return &Refusal{Reason: ReasonNonce}
	case statement.Commitment != a.label.Commitment:
		return &Refusal{Reason: ReasonCommitment}
	}

	// The served time has one-second resolution, so both ends of the window round outward.
	earliest := a.labeledAt.Add(-ServedAtAllowance).Unix()
	latest := presentedAt.Add(ServedAtAllowance)
	if latest.Nanosecond() > 0 {
		latest = latest.Add(time.Second)
	}
	if served := statement.ServedAt.Unix(); served < earliest || served > latest.Unix() {
		return &Refusal{Reason: ReasonServedAt}
	}

	if err := a.limits.Allows(statement.Conditions); err != nil {
		return &Refusal{Reason: ReasonConditions, cause: err}
	}

	return nil
}

// commitment returns the keyed commitment to request for operatorDID and nonce.
func commitment(auditKey []byte, operatorDID string, nonce [NonceSize]byte, request []byte) [sha256.Size]byte {
	mac := hmac.New(sha256.New, requestKey(auditKey, operatorDID, nonce))
	// Write on a hash never returns an error.
	mac.Write(request)

	return [sha256.Size]byte(mac.Sum(nil))
}

// requestKey returns the key for the commitment of one request.
// NOTE: operatorDID must not contain a NUL byte.
func requestKey(auditKey []byte, operatorDID string, nonce [NonceSize]byte) []byte {
	mac := hmac.New(sha256.New, auditKey)
	// The fields are NUL-separated.
	// Write on a hash never returns an error.
	mac.Write(slices.Concat([]byte(domainSeparator), []byte{0}, []byte(operatorDID), []byte{0}, nonce[:]))

	return mac.Sum(nil)
}
