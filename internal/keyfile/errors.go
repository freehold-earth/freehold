package keyfile

import "errors"

var (
	// ErrExists is returned when a file already exists at the path of a new key file.
	ErrExists = errors.New("file already exists")

	// ErrNotKey is returned when a file does not hold exactly one Ed25519 private key and nothing else.
	ErrNotKey = errors.New("not an Ed25519 private key file")

	// ErrShared is returned when someone other than the owner of a key file can access it.
	ErrShared = errors.New("key file is open to others")
)
