package receipt

// The reasons a receipt is refused.
const (
	// ReasonCommitment means the commitment does not match the request.
	ReasonCommitment Reason = "commitment"

	// ReasonConditions means the conditions exceed what the governing rule permits.
	ReasonConditions Reason = "conditions"

	// ReasonMalformed means the input is not a valid receipt object.
	ReasonMalformed Reason = "malformed"

	// ReasonMissing means no receipt was provided.
	ReasonMissing Reason = "missing"

	// ReasonNonce means the nonce does not match the request.
	ReasonNonce Reason = "nonce"

	// ReasonOperator means the receipt names a different operator.
	ReasonOperator Reason = "operator"

	// ReasonServedAt means the served time is outside the allowed window.
	ReasonServedAt Reason = "served_at"

	// ReasonSignature means the signature does not verify.
	ReasonSignature Reason = "signature"

	// ReasonSpent means the Awaited was already used, or is a zero value.
	ReasonSpent Reason = "spent"

	// ReasonTerms means the terms hash does not match the request.
	ReasonTerms Reason = "terms"
)

// Reason identifies the check that a receipt failed.
type Reason string

// Refusal is the error for a receipt that fails a check.
// NOTE: Its text contains no free text copied from the receipt.
type Refusal struct {
	// Reason is the check that failed.
	Reason Reason

	// cause is the underlying error, or nil.
	cause error
}

// Error returns the reason, followed by the cause when there is one.
func (r *Refusal) Error() string {
	message := "receipt refused: " + string(r.Reason)
	if r.cause != nil {
		message += ": " + r.cause.Error()
	}

	return message
}

// Unwrap returns the cause, or nil.
func (r *Refusal) Unwrap() error {
	return r.cause
}
