package client

// The outcomes of a request.
const (
	// OutcomeFailed is the outcome of a request that ended in an error other than a refusal.
	// The operator may hold the request, and no receipt binds it.
	OutcomeFailed Outcome = "failed"

	// OutcomeReceipted is the outcome of a request that the operator answered with a valid receipt.
	OutcomeReceipted Outcome = "receipted"

	// OutcomeRefused is the outcome of a request that the operator refused.
	OutcomeRefused Outcome = "refused"

	// OutcomeUnreceipted is the outcome of a request that the operator answered without a valid receipt.
	OutcomeUnreceipted Outcome = "unreceipted"
)

// Outcome is how a request that was sent to an operator ended.
type Outcome string
