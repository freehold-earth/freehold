package receipt

import "errors"

var (
	// ErrKey is returned when the key given to sign with is not an Ed25519 private key.
	ErrKey = errors.New("not an Ed25519 private key")

	// ErrStatement is returned when a statement holds a value that no valid receipt can carry.
	ErrStatement = errors.New("statement cannot be signed")
)
