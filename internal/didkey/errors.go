package didkey

import "errors"

// ErrNotEd25519 is returned when a value is not an Ed25519 public key, or not the did:key identifier of one.
var ErrNotEd25519 = errors.New("not an Ed25519 did:key")
