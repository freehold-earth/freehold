package keyfile

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"runtime"
)

const (
	// blockType is the PEM label of a PKCS #8 private key.
	blockType = "PRIVATE KEY"

	// maxSize is more bytes than any key file holds. A file is read no further than this.
	maxSize = 4096

	// others are the permission bits that let anyone but a file's owner reach it.
	others fs.FileMode = 0o077

	// ownerOnly is the permission a key file is written with: its owner may read and write it, and nobody else.
	ownerOnly fs.FileMode = 0o600
)

// Create makes a new Ed25519 private key, writes it to a new file at path that only its owner can read, and returns
// it.
//
// It returns ErrExists if there is already a file at path. It never writes over one: a key that is replaced is an
// identity that is lost.
func Create(path string) (ed25519.PrivateKey, error) {
	_, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, fmt.Errorf("generating a key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encoding the key: %w", err)
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, ownerOnly)
	if errors.Is(err, fs.ErrExist) {
		return nil, fmt.Errorf("%w: %s", ErrExists, path)
	}
	if err != nil {
		return nil, fmt.Errorf("creating the key file: %w", err)
	}

	err = errors.Join(pem.Encode(file, &pem.Block{Type: blockType, Bytes: der}), file.Close())
	if err != nil {
		// Half a key is worse than none: it would stop the next attempt and can never be read.
		return nil, errors.Join(fmt.Errorf("writing the key file: %w", err), os.Remove(path))
	}

	return key, nil
}

// Read returns the Ed25519 private key in the file at path.
//
// It returns ErrShared if anyone but the file's owner can reach the file, and ErrNotKey if the file holds anything
// other than one PEM-encoded PKCS #8 Ed25519 private key.
func Read(path string) (key ed25519.PrivateKey, err error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("opening the key file: %w", err)
	}
	defer func() { err = errors.Join(err, file.Close()) }()

	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("reading the key file: %w", err)
	}
	// Windows reports no permission bits worth reading: access there is by lists this check cannot see.
	if runtime.GOOS != "windows" && info.Mode().Perm()&others != 0 {
		return nil, fmt.Errorf("%w: %s has mode %04o, want %04o", ErrShared, path, info.Mode().Perm(), ownerOnly)
	}

	// One byte past the limit is read so that a file over it is seen as such and not cut short.
	encoded, err := io.ReadAll(io.LimitReader(file, maxSize+1))
	if err != nil {
		return nil, fmt.Errorf("reading the key file: %w", err)
	}
	if len(encoded) > maxSize {
		return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrNotKey, path, maxSize)
	}

	block, rest := pem.Decode(encoded)
	if block == nil || block.Type != blockType || len(bytes.TrimSpace(rest)) != 0 {
		return nil, fmt.Errorf("%w: %s is not one PEM block of type %s", ErrNotKey, path, blockType)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		// What failed to parse is key material, so the parser's own account of it is left out.
		return nil, fmt.Errorf("%w: %s does not hold a PKCS #8 key", ErrNotKey, path)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%w: %s holds a key of another kind", ErrNotKey, path)
	}

	return key, nil
}
