package receipt

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
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
// A Receipt comes from Sign. Hashes and the nonce are lowercase hex, and the signature is standard base64.
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

	// RetentionSeconds is how long the operator keeps what it was sent; zero is not at all.
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
// It returns ErrKey if key is not an Ed25519 private key, and ErrStatement if the statement holds a value that no
// valid receipt can carry.
func Sign(key ed25519.PrivateKey, statement Statement) (Receipt, error) {
	if len(key) != ed25519.PrivateKeySize {
		return Receipt{}, fmt.Errorf("%w: a key is %d bytes, got %d", ErrKey, ed25519.PrivateKeySize, len(key))
	}
	// The assertion is safe: Public returns an ed25519.PublicKey for a key of the right length, checked above.
	operatorDID, err := didkey.FromPublicKey(key.Public().(ed25519.PublicKey))
	if err != nil {
		return Receipt{}, fmt.Errorf("%w: %w", ErrKey, err)
	}

	if err := statement.validate(); err != nil {
		return Receipt{}, err
	}
	// The conversion is safe: validate refuses a time before 1970.
	servedAt := uint64(statement.ServedAt.Unix())

	signed, err := signedBytes(operatorDID, servedAt, statement)
	if err != nil {
		return Receipt{}, fmt.Errorf("%w: %w", ErrStatement, err)
	}

	return Receipt{
		OperatorDID:      operatorDID,
		TermsHash:        hex.EncodeToString(statement.TermsHash[:]),
		Nonce:            hex.EncodeToString(statement.Nonce[:]),
		Commitment:       hex.EncodeToString(statement.Commitment[:]),
		RequestID:        statement.RequestID,
		ServedAt:         servedAt,
		Custody:          statement.Conditions.Custody,
		RetentionSeconds: statement.Conditions.RetentionSeconds,
		Training:         statement.Conditions.Training,
		Aggregation:      statement.Conditions.Aggregation,
		Resale:           statement.Conditions.Resale,
		Signature:        base64.StdEncoding.EncodeToString(ed25519.Sign(key, signed)),
	}, nil
}

// signedBytes returns the canonical bytes a receipt is signed over: the structure spal/receipt/v1, whose field order
// is fixed by spec/protocols/preimage-encoding.md.
func signedBytes(operatorDID string, servedAt uint64, statement Statement) ([]byte, error) {
	conditions := statement.Conditions

	return preimage.Encode(
		preimage.Text(domainSeparator),
		preimage.Text(operatorDID),
		preimage.Fixed(statement.TermsHash[:], sha256.Size),
		preimage.Fixed(statement.Nonce[:], NonceSize),
		preimage.Fixed(statement.Commitment[:], sha256.Size),
		preimage.Text(statement.RequestID),
		preimage.Fixed(binary.BigEndian.AppendUint64(nil, servedAt), integerSize),
		preimage.Text(string(conditions.Custody)),
		preimage.Fixed(binary.BigEndian.AppendUint64(nil, conditions.RetentionSeconds), integerSize),
		preimage.Text(string(conditions.Training)),
		preimage.Text(string(conditions.Aggregation)),
		preimage.Text(string(conditions.Resale)),
	)
}

// validate returns an ErrStatement naming the first value in the statement that no valid receipt can carry.
func (s Statement) validate() error {
	if err := s.Conditions.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrStatement, err)
	}

	if len(s.RequestID) > RequestIDMaxBytes {
		return fmt.Errorf("%w: request_id is longer than %d bytes", ErrStatement, RequestIDMaxBytes)
	}
	if !utf8.ValidString(s.RequestID) {
		return fmt.Errorf("%w: request_id is not valid UTF-8", ErrStatement)
	}
	for _, char := range s.RequestID {
		if unicode.In(char, unicode.Cc, unicode.Cf, unicode.Zl, unicode.Zp) {
			return fmt.Errorf("%w: request_id carries a control character or a line separator", ErrStatement)
		}
	}

	servedAt := s.ServedAt.Unix()
	if servedAt < 0 || servedAt > spal.MaxSafeInteger {
		return fmt.Errorf("%w: served_at is outside the range a receipt can carry", ErrStatement)
	}

	return nil
}
