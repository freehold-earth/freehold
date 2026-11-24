package client

import "github.com/freehold-earth/freehold/internal/terms"

// Refusal is the error for a request that an operator received and refused.
// Its text holds nothing that the operator chose.
type Refusal struct {
	// Condition is the name of the condition the refusal concerns, for a reason that names one.
	// NOTE: It is text that the operator chose, so it should not be given to a model.
	Condition string

	// Reason is the reason for the refusal.
	// It is empty when the operator gave a reason that the extension does not define.
	Reason terms.Reason
}

// Error returns the reason for the refusal.
func (r *Refusal) Error() string {
	if r.Reason == "" {
		return "the operator refused the request for a reason that is not defined"
	}

	return "the operator refused the request: " + string(r.Reason)
}
