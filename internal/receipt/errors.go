package receipt

import "errors"

var (
	// ErrAuditKey is returned when an audit key is shorter than AuditKeyMinBytes.
	ErrAuditKey = errors.New("audit key is too short")

	// ErrKey is returned when the key given to sign with is not an Ed25519 private key.
	ErrKey = errors.New("not an Ed25519 private key")

	// ErrStatement is returned when a statement holds a value that no valid receipt can carry.
	ErrStatement = errors.New("statement cannot be signed")

	// ErrTerms is returned when a request has no terms.
	ErrTerms = errors.New("request has no terms")
)
