package terms

// The reasons an operator refuses a request, spelled as they travel.
const (
	// ReasonCannotHonor says the operator cannot keep a condition of the rule that governs the request.
	ReasonCannotHonor Reason = "cannot_honour"

	// ReasonConditionNotUnderstood says the terms ask for something the operator does not understand.
	ReasonConditionNotUnderstood Reason = "condition_not_understood"

	// ReasonScopeNotGoverned says no rule in the terms governs the scope the request names.
	ReasonScopeNotGoverned Reason = "scope_not_governed"

	// ReasonTermsMalformed says what the request carries about its terms is not well formed.
	ReasonTermsMalformed Reason = "terms_malformed"

	// ReasonTermsMismatch says the terms sent do not have the hash the request names.
	ReasonTermsMismatch Reason = "terms_mismatch"

	// ReasonTermsRequired says the request carries no terms and the operator serves nothing without them.
	ReasonTermsRequired Reason = "terms_required"

	// ReasonTermsUnknown says the operator does not hold the terms the request names.
	ReasonTermsUnknown Reason = "terms_unknown"
)

// The conditions of a rule, as the terms and a refusal name them.
const (
	// conditionAggregation is the rule's limit on aggregating what the operator is sent.
	conditionAggregation = "aggregation"

	// conditionAttestation is the rule's demand that the operator prove what it runs.
	conditionAttestation = "attestation"

	// conditionCustody is the rule's limit on whose machine may hold the data.
	conditionCustody = "custody"

	// conditionDerivatives is the rule's condition on what may be derived from the data, as the terms name it. A
	// refusal names the derivative itself: training, aggregation or resale.
	conditionDerivatives = "derivatives"

	// conditionIdentity is the rule's condition on who may ask for the data, which binds a business and not an
	// operator.
	conditionIdentity = "identity"

	// conditionPayment is the rule's condition on what the data costs, which binds a business and not an operator.
	conditionPayment = "payment"

	// conditionProofs is the rule's condition on what must be proved to get the data, which binds a business and not
	// an operator.
	conditionProofs = "proofs"

	// conditionResale is the rule's limit on selling on what the operator is sent.
	conditionResale = "resale"

	// conditionRetention is the rule's limit on how long the operator keeps what it is sent.
	conditionRetention = "retention"

	// conditionTraining is the rule's limit on training models on what the operator is sent.
	conditionTraining = "training"
)

// Reason is why an operator refuses a request made under terms, or made without them.
type Reason string

// Refusal is an operator's refusal of a request. It is the error this package returns for a request that must not be
// served.
type Refusal struct {
	// Reason is why the request is refused.
	Reason Reason

	// Condition names what the refusal is about, for the two reasons that have something to name: the condition the
	// operator cannot honor, or the member of the terms it does not understand. It is empty otherwise.
	Condition string

	// cause is what was found wrong, or nil where the reason says it all.
	cause error
}

// Error describes the refusal: its reason, then its condition and what was found wrong, where it has them.
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

// Unwrap returns what was found wrong, or nil where the reason says it all.
func (r *Refusal) Unwrap() error {
	return r.cause
}
