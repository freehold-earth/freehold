package didkey

import (
	"bytes"
	"crypto/ed25519"
	"fmt"
	"slices"
	"strings"
)

const (
	// maxEncodedLen is the maximum number of base58 digits in the encoding of a tagged Ed25519 public key.
	maxEncodedLen = 47

	// prefix is the did:key method followed by "z", the multibase code for base58.
	prefix = "did:key:z"
)

// ed25519Tag is the multicodec prefix of an Ed25519 public key.
var ed25519Tag = []byte{0xed, 0x01}

// FromPublicKey returns the did:key identifier of key.
// It returns ErrNotEd25519 if key is not the length of an Ed25519 public key.
func FromPublicKey(key ed25519.PublicKey) (string, error) {
	if len(key) != ed25519.PublicKeySize {
		return "", fmt.Errorf("%w: a public key is %d bytes, got %d", ErrNotEd25519, ed25519.PublicKeySize, len(key))
	}

	return prefix + base58Encode(slices.Concat(ed25519Tag, key)), nil
}

// PublicKey returns the Ed25519 public key that the did:key identifier did encodes.
// It returns ErrNotEd25519 if did is not a did:key that holds exactly one Ed25519 public key.
func PublicKey(did string) (ed25519.PublicKey, error) {
	encoded, ok := strings.CutPrefix(did, prefix)
	if !ok {
		return nil, fmt.Errorf("%w: the identifier does not begin %s", ErrNotEd25519, prefix)
	}

	// Decoding takes more than linear time, so overlong text is refused first.
	if len(encoded) > maxEncodedLen {
		return nil, fmt.Errorf("%w: the identifier is too long", ErrNotEd25519)
	}

	tagged, ok := base58Decode(encoded)
	if !ok {
		return nil, fmt.Errorf("%w: the identifier is not base58", ErrNotEd25519)
	}

	key, ok := bytes.CutPrefix(tagged, ed25519Tag)
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: the identifier does not carry an Ed25519 public key", ErrNotEd25519)
	}

	return ed25519.PublicKey(key), nil
}
