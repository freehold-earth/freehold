package receipt

import (
	"crypto/ed25519"
	"encoding"
	"encoding/base64"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/freehold-earth/freehold/internal/spal"
)

// The member names of a receipt object.
const (
	// memberAggregation is the name of the aggregation condition.
	memberAggregation = "aggregation"

	// memberCommitment is the name of the commitment.
	memberCommitment = "commitment"

	// memberCustody is the name of the custody level.
	memberCustody = "custody"

	// memberNonce is the name of the nonce.
	memberNonce = "nonce"

	// memberOperatorDID is the name of the signer's decentralized identifier (DID).
	memberOperatorDID = "operator_did"

	// memberRequestID is the name of the operator's request ID.
	memberRequestID = "request_id"

	// memberResale is the name of the resale condition.
	memberResale = "resale"

	// memberRetentionSeconds is the name of the retention period.
	memberRetentionSeconds = "retention_seconds"

	// memberServedAt is the name of the served time.
	memberServedAt = "served_at"

	// memberSignature is the name of the signature.
	memberSignature = "signature"

	// memberTermsHash is the name of the terms hash.
	memberTermsHash = "terms_hash"

	// memberTraining is the name of the training condition.
	memberTraining = "training"
)

// members lists every member of a receipt object, in the order of the specification.
var members = []string{
	memberOperatorDID,
	memberTermsHash,
	memberNonce,
	memberCommitment,
	memberRequestID,
	memberServedAt,
	memberCustody,
	memberRetentionSeconds,
	memberTraining,
	memberAggregation,
	memberResale,
	memberSignature,
}

// reader reads the members of a receipt object and keeps the first error.
type reader struct {
	// err is the first error, or nil.
	err error

	// object maps each member name to its raw value.
	object map[string]jsontext.Value
}

// signedStatement is the parsed content of a receipt object.
type signedStatement struct {
	// operator is the signer's DID.
	operator string

	// signature is the signature over the statement.
	signature []byte

	// statement is the signed statement.
	statement Statement
}

// fixedHex decodes the member name into target, which must be lowercase hex of exactly that length.
func (r *reader) fixedHex(name string, target []byte) {
	text := r.text(name)
	if r.err != nil {
		return
	}

	// Decoding accepts upper case, so the text is compared with its re-encoding.
	decoded, err := hex.DecodeString(text)
	if err != nil || len(decoded) != len(target) || hex.EncodeToString(decoded) != text {
		r.err = fmt.Errorf("%s is not %d lowercase hex characters", name, hex.EncodedLen(len(target)))
		return
	}
	copy(target, decoded)
}

// integer returns the member name, which must be an integer from 0 to 2^53 - 1 written in digits only.
func (r *reader) integer(name string) uint64 {
	if r.err != nil {
		return 0
	}

	written := r.object[name]
	number, err := strconv.ParseUint(string(written), 10, 64)
	if err != nil || number > spal.MaxSafeInteger {
		r.err = fmt.Errorf("%s is not a whole number from 0 to 2^53 - 1", name)
		return 0
	}

	return number
}

// read parses data as a receipt object.
// NOTE: The error text contains nothing copied from data.
func read(data []byte) (signedStatement, error) {
	if jsontext.Value(data).Kind() != '{' {
		return signedStatement{}, errors.New("not a JSON object")
	}

	r := reader{}
	if err := json.Unmarshal(data, &r.object); err != nil {
		return signedStatement{}, errors.New("not well-formed JSON")
	}
	for _, name := range members {
		if _, ok := r.object[name]; !ok {
			return signedStatement{}, fmt.Errorf("%s is missing", name)
		}
	}
	// Every required member is present, so a different count means an unknown member.
	if len(r.object) != len(members) {
		return signedStatement{}, errors.New("a member a receipt does not have")
	}

	var statement Statement
	operator := r.text(memberOperatorDID)
	r.fixedHex(memberTermsHash, statement.TermsHash[:])
	r.fixedHex(memberNonce, statement.Nonce[:])
	r.fixedHex(memberCommitment, statement.Commitment[:])
	statement.RequestID = r.text(memberRequestID)
	// The conversion cannot overflow because integer returns at most 2^53 - 1.
	statement.ServedAt = time.Unix(int64(r.integer(memberServedAt)), 0)
	r.word(memberCustody, &statement.Conditions.Custody)
	statement.Conditions.RetentionSeconds = r.integer(memberRetentionSeconds)
	r.word(memberTraining, &statement.Conditions.Training)
	r.word(memberAggregation, &statement.Conditions.Aggregation)
	r.word(memberResale, &statement.Conditions.Resale)
	encoded := r.text(memberSignature)
	if r.err != nil {
		return signedStatement{}, r.err
	}

	// Decoding ignores line breaks, so the text is compared with its re-encoding.
	signature, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(signature) != encoded ||
		len(signature) != ed25519.SignatureSize {
		return signedStatement{}, fmt.Errorf("%s is not the canonical base64 of an Ed25519 signature", memberSignature)
	}

	if err := statement.validate(); err != nil {
		return signedStatement{}, err
	}

	return signedStatement{operator: operator, signature: signature, statement: statement}, nil
}

// text returns the member name, which must be a JSON string.
func (r *reader) text(name string) string {
	if r.err != nil {
		return ""
	}

	var text string
	written := r.object[name]
	if written.Kind() != '"' || json.Unmarshal(written, &text) != nil {
		r.err = fmt.Errorf("%s is not text", name)
		return ""
	}

	return text
}

// word decodes the member name into target, which must accept it as an S-PAL value.
func (r *reader) word(name string, target encoding.TextUnmarshaler) {
	text := r.text(name)
	if r.err != nil {
		return
	}

	if target.UnmarshalText([]byte(text)) != nil {
		r.err = fmt.Errorf("%s is not a value S-PAL allows for it", name)
	}
}
