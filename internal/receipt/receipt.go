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
	// NonceSize is the length of a request nonce in bytes.
	NonceSize = 16

	// RequestIDMaxBytes is the maximum length of a request ID in bytes of UTF-8.
	RequestIDMaxBytes = 128

	// domainSeparator is the first field of the signed bytes, and is unique to receipts.
	domainSeparator = "spal/receipt/v1"

	// integerSize is the width of an integer field in the signed bytes.
	integerSize = 8
)

// Receipt is a signed terms receipt in its wire form.
// Hashes and the nonce are lowercase hex, and the signature is standard base64.
// The fields are in wire order.
type Receipt struct {
	// OperatorDID is the decentralized identifier (DID) of the operator that signs the receipt.
	OperatorDID string `json:"operator_did"`

	// TermsHash is the hash of the terms the request was served under.
	TermsHash string `json:"terms_hash"`

	// Nonce is the nonce the request carried.
	Nonce string `json:"nonce"`

	// Commitment is the commitment the request carried.
	Commitment string `json:"commitment"`

	// RequestID is the operator's own ID for the request, which may be empty.
	RequestID string `json:"request_id"`

	// ServedAt is the time the request was served, in Unix seconds.
	ServedAt uint64 `json:"served_at"`

	// Custody is the custody level the request ran at.
	Custody spal.Custody `json:"custody"`

	// RetentionSeconds is the longest the operator keeps the request data, where zero means it keeps none.
	RetentionSeconds uint64 `json:"retention_seconds"`

	// Training is the training condition the operator commits to.
	Training spal.Training `json:"training"`

	// Aggregation is the aggregation condition the operator commits to.
	Aggregation spal.Aggregation `json:"aggregation"`

	// Resale is the resale condition the operator commits to.
	Resale spal.Resale `json:"resale"`

	// Signature is the operator's Ed25519 signature over the canonical bytes of the receipt.
	Signature string `json:"signature"`
}

// Statement is the content of a receipt before it is signed.
type Statement struct {
	// Commitment is the commitment the request carried.
	Commitment [sha256.Size]byte

	// Conditions is what the operator commits to for the request.
	Conditions spal.Conditions

	// Nonce is the nonce the request carried.
	Nonce [NonceSize]byte

	// RequestID is the operator's own ID for the request, which may be empty.
	// NOTE: It must be at most RequestIDMaxBytes long and must contain no control, format or line-separator character.
	RequestID string

	// ServedAt is the time the request was served, which a receipt records to the second.
	ServedAt time.Time

	// TermsHash is the hash of the terms the request was served under.
	TermsHash [sha256.Size]byte
}

// Sign returns the receipt for statement, signed with key.
// The signer is the did:key of the public half of key.
// It returns ErrKey when key is not a valid Ed25519 private key, and ErrStatement when the statement is not valid.
func Sign(key ed25519.PrivateKey, statement Statement) (Receipt, error) {
	if len(key) != ed25519.PrivateKeySize {
		return Receipt{}, fmt.Errorf("%w: a key is %d bytes, got %d", ErrKey, ed25519.PrivateKeySize, len(key))
	}
	// Signing trusts the public half as given, so a mismatched key would sign as a DID that cannot verify.
	if !ed25519.NewKeyFromSeed(key.Seed()).Equal(key) {
		return Receipt{}, fmt.Errorf("%w: public half does not belong to its seed", ErrKey)
	}
	// The assertion cannot fail because the key length is checked above.
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
