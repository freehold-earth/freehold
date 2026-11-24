package terms

// The reasons an operator refuses a request, with their wire values.
const (
	// ReasonCannotHonor means the operator cannot keep a condition of the governing rule.
	ReasonCannotHonor Reason = "cannot_honour"

	// ReasonConditionNotUnderstood means the terms contain something the operator does not understand.
	ReasonConditionNotUnderstood Reason = "condition_not_understood"

	// ReasonScopeNotGoverned means no rule in the terms governs the scope of the request.
	ReasonScopeNotGoverned Reason = "scope_not_governed"

	// ReasonTermsMalformed means the terms data in the request is malformed.
	ReasonTermsMalformed Reason = "terms_malformed"

	// ReasonTermsMismatch means the terms sent do not match the hash the request names.
	ReasonTermsMismatch Reason = "terms_mismatch"

	// ReasonTermsRequired means the request carries no terms.
	ReasonTermsRequired Reason = "terms_required"

	// ReasonTermsUnknown means the operator does not hold the terms the request names.
	ReasonTermsUnknown Reason = "terms_unknown"
)

// The names of the conditions of a rule.
const (
	// conditionAggregation names the limit on aggregating the data.
	conditionAggregation = "aggregation"

	// conditionAttestation names the requirement that the operator attest to what it runs.
	conditionAttestation = "attestation"

	// conditionCustody names the limit on which machines may hold the data.
	conditionCustody = "custody"

	// conditionDerivatives names the group of derivative conditions: training, aggregation and resale.
	conditionDerivatives = "derivatives"

	// conditionIdentity names the condition on who may request the data.
	// It binds a business, not an operator.
	conditionIdentity = "identity"

	// conditionPayment names the condition on the price of the data.
	// It binds a business, not an operator.
	conditionPayment = "payment"

	// conditionProofs names the condition on what a requester must prove.
	// It binds a business, not an operator.
	conditionProofs = "proofs"

	// conditionResale names the limit on reselling the data.
	conditionResale = "resale"

	// conditionRetention names the limit on how long the operator keeps the data.
	conditionRetention = "retention"

	// conditionTraining names the limit on training models on the data.
	conditionTraining = "training"
)

// Reason identifies why an operator refuses a request.
type Reason string

// Refusal is the error for a request that an operator must not serve.
type Refusal struct {
	// Condition names the condition the operator cannot honor, or the member it does not understand.
	// It is empty for every other reason.
	Condition string

	// Reason is why the request is refused.
	Reason Reason

	// cause is the underlying error, or nil.
	cause error
}

// Error returns the reason, followed by the condition and the cause when they are set.
func (r *Refusal) Error() string {
	message := "terms refused: " + string(r.Reason)
	if r.Condition != "" {
		message += ": " + r.Condition
	}
	if r.cause != nil {
		message += ": " + r.cause.Error()
	}

	return message
}

// Unwrap returns the cause, or nil.
func (r *Refusal) Unwrap() error {
	return r.cause
}
