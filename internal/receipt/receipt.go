package receipt

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/preimage"
	"github.com/freehold-earth/freehold/internal/spal"
)

const (
	// NonceSize is the number of bytes in the nonce a request is sent with.
	NonceSize = 16

	// RequestIDMaxBytes is the longest handle an operator may give a request, in bytes of UTF-8.
	RequestIDMaxBytes = 128

	// domainSeparator is the first field of the bytes a receipt is signed over, which no other structure shares.
	domainSeparator = "spal/receipt/v1"

	// integerSize is the width in bytes of an integer field in the signed bytes.
	integerSize = 8
)

// Receipt is a signed terms receipt in the form it travels in: one member per field, and the signature.
//
// Hashes and the nonce are lowercase hex, and the signature is standard base64.
type Receipt struct {
	// OperatorDID is who served the request and signs for it.
	OperatorDID string `json:"operator_did"`

	// TermsHash is the hash of the terms the request was served under.
	TermsHash string `json:"terms_hash"`

	// Nonce is the nonce the request was sent with.
	Nonce string `json:"nonce"`

	// Commitment is the commitment the request was sent with.
	Commitment string `json:"commitment"`

	// RequestID is the operator's own handle for the request; it may be empty.
	RequestID string `json:"request_id"`

	// ServedAt is when the request was served, in unix seconds.
	ServedAt uint64 `json:"served_at"`

	// Custody is the custody level the request was run at.
	Custody spal.Custody `json:"custody"`

	// RetentionSeconds is the longest the operator keeps what it was sent; zero is not at all.
	RetentionSeconds uint64 `json:"retention_seconds"`

	// Training is whether the operator may train models on what it was sent.
	Training spal.Training `json:"training"`

	// Aggregation is whether the operator may aggregate what it was sent.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale is whether the operator may sell on what it was sent.
	Resale spal.Resale `json:"resale"`

	// Signature is the operator's Ed25519 signature over the receipt's canonical bytes.
	Signature string `json:"signature"`
}

// Statement is what an operator says about one request it served, before it signs.
type Statement struct {
	// TermsHash is the hash of the terms the request was served under.
	TermsHash [sha256.Size]byte

	// Nonce is the nonce the request was sent with, copied as given.
	Nonce [NonceSize]byte

	// Commitment is the commitment the request was sent with, copied as given.
	Commitment [sha256.Size]byte

	// RequestID is the operator's own handle for the request. It may be empty. It is at most RequestIDMaxBytes long
	// and stays on one line: no control or format character, and no line or paragraph separator.
	RequestID string

	// ServedAt is when the request was served. A receipt carries it to the second.
	ServedAt time.Time

	// Conditions is what the operator commits to for the request.
	Conditions spal.Conditions
}

// Sign returns the receipt for statement, signed with key as the did:key identifier of key's public half.
//
// It returns ErrKey if key is not an Ed25519 private key whose public half belongs to its seed, and ErrStatement if the statement holds a value that no
// valid receipt can carry.
func Sign(key ed25519.PrivateKey, statement Statement) (Receipt, error) {
	if len(key) != ed25519.PrivateKeySize {
		return Receipt{}, fmt.Errorf("%w: a key is %d bytes, got %d", ErrKey, ed25519.PrivateKeySize, len(key))
	}
	// A key is a seed followed by the public key the seed makes. Signing trusts the second half as given, so a key
	// whose halves disagree would sign as an identity that cannot verify the signature.
	if !ed25519.NewKeyFromSeed(key.Seed()).Equal(key) {
		return Receipt{}, fmt.Errorf("%w: public half does not belong to its seed", ErrKey)
	}
	// The assertion is safe: Public returns an ed25519.PublicKey for a key of the right length, checked above.
	operatorDID, err := didkey.FromPublicKey(key.Public().(ed25519.PublicKey))
	if err != nil {
		return Receipt{}, fmt.Errorf("%w: %w", ErrKey, err)
	}

	if err := statement.validate(); err != nil {
		return Receipt{}, fmt.Errorf("%w: %w", ErrStatement, err)
	}

	signed, err := statement.signedBytes(operatorDID)
	if err != nil {
		return Receipt{}, fmt.Errorf("%w: %w", ErrStatement, err)
	}

	return statement.receipt(operatorDID, ed25519.Sign(key, signed)), nil
}

// receipt returns the wire form of the statement, signed by operatorDID with signature.
// NOTE: The statement must be valid.
func (s Statement) receipt(operatorDID string, signature []byte) Receipt {
	return Receipt{
		OperatorDID: operatorDID,
		TermsHash:   hex.EncodeToString(s.TermsHash[:]),
		Nonce:       hex.EncodeToString(s.Nonce[:]),
		Commitment:  hex.EncodeToString(s.Commitment[:]),
		RequestID:   s.RequestID,
		// The conversion cannot overflow because validate rejects a time before 1970.
		ServedAt:         uint64(s.ServedAt.Unix()),
		Custody:          s.Conditions.Custody,
		RetentionSeconds: s.Conditions.RetentionSeconds,
		Training:         s.Conditions.Training,
		Aggregation:      s.Conditions.Aggregation,
		Resale:           s.Conditions.Resale,
		Signature:        base64.StdEncoding.EncodeToString(signature),
	}
}

// signedBytes returns the canonical bytes that operatorDID signs for the statement.
// The field order is fixed by spec/protocols/preimage-encoding.md.
// NOTE: The statement must be valid.
func (s Statement) signedBytes(operatorDID string) ([]byte, error) {
	// The conversion cannot overflow because validate rejects a time before 1970.
	servedAt := uint64(s.ServedAt.Unix())

	return preimage.Encode(
		preimage.Text(domainSeparator),
		preimage.Text(operatorDID),
		preimage.Fixed(s.TermsHash[:], sha256.Size),
		preimage.Fixed(s.Nonce[:], NonceSize),
		preimage.Fixed(s.Commitment[:], sha256.Size),
		preimage.Text(s.RequestID),
		preimage.Fixed(binary.BigEndian.AppendUint64(nil, servedAt), integerSize),
		preimage.Text(string(s.Conditions.Custody)),
		preimage.Fixed(binary.BigEndian.AppendUint64(nil, s.Conditions.RetentionSeconds), integerSize),
		preimage.Text(string(s.Conditions.Training)),
		preimage.Text(string(s.Conditions.Aggregation)),
		preimage.Text(string(s.Conditions.Resale)),
	)
}

// validate returns an error for the first value in the statement that no valid receipt can carry.
func (s Statement) validate() error {
	if err := s.Conditions.Validate(); err != nil {
		return err
	}

	if len(s.RequestID) > RequestIDMaxBytes {
		return fmt.Errorf("request_id is longer than %d bytes", RequestIDMaxBytes)
	}
	if !utf8.ValidString(s.RequestID) {
		return errors.New("request_id is not valid UTF-8")
	}
	for _, char := range s.RequestID {
		if unicode.In(char, unicode.Cc, unicode.Cf, unicode.Zl, unicode.Zp) {
			return errors.New("request_id carries a control character or a line separator")
		}
	}

	servedAt := s.ServedAt.Unix()
	if servedAt < 0 || servedAt > spal.MaxSafeInteger {
		return errors.New("served_at is outside the range a receipt can carry")
	}

	return nil
}
