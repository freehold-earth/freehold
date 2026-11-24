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
	// beginMarker is the start of every PEM block.
	beginMarker = "-----BEGIN"

	// blockType is the PEM label of a PKCS #8 private key.
	blockType = "PRIVATE KEY"

	// maxSize is the maximum size of a key file in bytes.
	maxSize = 4096

	// others is the permission bits that grant access to anyone but a file's owner.
	others fs.FileMode = 0o077

	// ownerOnly is the permission bits of a new key file, which let only its owner read and write it.
	ownerOnly fs.FileMode = 0o600
)

// Create generates an Ed25519 private key, writes it to a new owner-only file at path, and returns it.
// It returns ErrExists if a file already exists at path, and it never overwrites one.
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
		// A partial key file is removed because it cannot be read and would block the next Create.
		return nil, errors.Join(fmt.Errorf("writing the key file: %w", err), os.Remove(path))
	}

	return key, nil
}

// Read returns the Ed25519 private key in the file at path.
// It returns ErrShared if anyone but the file's owner can access the file.
// NOTE: On Windows it does not check who can access the file.
// It returns ErrNotKey if the file holds anything other than one PEM-encoded PKCS #8 Ed25519 private key.
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
	// Windows controls access with lists, which permission bits do not reflect.
	if runtime.GOOS != "windows" && info.Mode().Perm()&others != 0 {
		return nil, fmt.Errorf("%w: %s has mode %04o, want %04o", ErrShared, path, info.Mode().Perm(), ownerOnly)
	}

	// Reading one byte past the limit distinguishes an oversized file from one that is exactly at the limit.
	encoded, err := io.ReadAll(io.LimitReader(file, maxSize+1))
	if err != nil {
		return nil, fmt.Errorf("reading the key file: %w", err)
	}
	if len(encoded) > maxSize {
		return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrNotKey, path, maxSize)
	}

	// Decoding skips anything before the first valid block, including a malformed block.
	// Content before the block, after it, or in its headers is refused separately.
	block, rest := pem.Decode(encoded)
	alone := bytes.HasPrefix(bytes.TrimSpace(encoded), []byte(beginMarker)) &&
		bytes.Count(encoded, []byte(beginMarker)) == 1 &&
		len(bytes.TrimSpace(rest)) == 0
	if block == nil || block.Type != blockType || len(block.Headers) != 0 || !alone {
		return nil, fmt.Errorf("%w: %s is not one PEM block of type %s and nothing else", ErrNotKey, path, blockType)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		// The parser's error is omitted because it describes key material.
		return nil, fmt.Errorf("%w: %s does not hold a PKCS #8 key", ErrNotKey, path)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%w: %s holds a key of another kind", ErrNotKey, path)
	}

	return key, nil
}
