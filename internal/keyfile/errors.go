package keyfile

import "errors"

var (
	// ErrExists is returned when a key is to be written where a file already is.
	ErrExists = errors.New("file already exists")

	// ErrNotKey is returned when a file does not hold one Ed25519 private key and nothing else.
	ErrNotKey = errors.New("not an Ed25519 private key file")

	// ErrShared is returned when a key file can be reached by someone other than its owner.
	ErrShared = errors.New("key file is open to others")
)
