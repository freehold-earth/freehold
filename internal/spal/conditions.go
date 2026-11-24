package spal

import (
	"errors"
	"fmt"
	"slices"
)

// MaxSafeInteger is the largest integer S-PAL carries, 2^53 - 1.
// Every implementation holds integers up to this value exactly.
const MaxSafeInteger = 1<<53 - 1

// The aggregation values.
const (
	// AggregationAllowed permits aggregation.
	AggregationAllowed Aggregation = "allowed"

	// AggregationAnonymizedOnly permits aggregation of anonymized data only.
	AggregationAnonymizedOnly Aggregation = "anonymized_only"

	// AggregationForbidden permits no aggregation.
	AggregationForbidden Aggregation = "forbidden"
)

// The custody levels, ordered from the one that keeps data closest to the end-user to the one that lets it go furthest.
const (
	// CustodyDeviceOnly keeps the data on the end-user's own device.
	CustodyDeviceOnly Custody = "device_only"

	// CustodyOwnedHardware keeps the data on hardware the end-user owns.
	CustodyOwnedHardware Custody = "owned_hardware"

	// CustodyCommunityNode lets the data reach a node run by someone the end-user knows.
	CustodyCommunityNode Custody = "community_node"

	// CustodyFederatedOperator lets the data reach an operator answerable through community governance.
	CustodyFederatedOperator Custody = "federated_operator"

	// CustodyAttestedEnclave lets the data reach any operator that proves what it runs.
	CustodyAttestedEnclave Custody = "attested_enclave"

	// CustodyAny lets the data reach any operator.
	CustodyAny Custody = "any"
)

// The hosted-models values.
const (
	// HostedModelsAllowed lets a hosted model service receive the data.
	HostedModelsAllowed HostedModels = "allowed"

	// HostedModelsForbidden keeps the data from any hosted model service.
	HostedModelsForbidden HostedModels = "forbidden"
)

// The resale values.
const (
	// ResaleAllowed permits resale.
	ResaleAllowed Resale = "allowed"

	// ResaleForbidden permits no resale.
	ResaleForbidden Resale = "forbidden"

	// ResaleRequiresConsent permits resale only with the end-user's consent.
	ResaleRequiresConsent Resale = "requires_consent"
)

// The training values.
const (
	// TrainingAllowed permits training.
	TrainingAllowed Training = "allowed"

	// TrainingForbidden permits no training.
	TrainingForbidden Training = "forbidden"

	// TrainingRequiresPayment permits training only against payment.
	TrainingRequiresPayment Training = "requires_payment"
)

var (
	// aggregations lists the Aggregation values, ordered from the one that permits least to the one that permits most.
	aggregations = []Aggregation{AggregationForbidden, AggregationAnonymizedOnly, AggregationAllowed}

	// custodyLevels lists the Custody values, ordered as S-PAL compares them.
	// The first level keeps data closest to the end-user, and the last lets it go furthest.
	custodyLevels = []Custody{
		CustodyDeviceOnly,
		CustodyOwnedHardware,
		CustodyCommunityNode,
		CustodyFederatedOperator,
		CustodyAttestedEnclave,
		CustodyAny,
	}

	// hostedModels lists the HostedModels values.
	hostedModels = []HostedModels{HostedModelsAllowed, HostedModelsForbidden}

	// resales lists the Resale values, ordered from the one that permits least to the one that permits most.
	resales = []Resale{ResaleForbidden, ResaleRequiresConsent, ResaleAllowed}

	// trainings lists the Training values, ordered from the one that permits least to the one that permits most.
	trainings = []Training{TrainingForbidden, TrainingRequiresPayment, TrainingAllowed}
)

// Aggregation is what an operator may do with aggregates of what it was sent.
type Aggregation string

// Conditions is what an operator commits to for a request it serves.
// The fields are in wire order.
type Conditions struct {
	// Custody is the custody level the operator runs at.
	Custody Custody `json:"custody"`

	// RetentionSeconds is the longest time the operator keeps what it is sent.
	// Zero means the operator keeps nothing.
	RetentionSeconds uint64 `json:"retention_seconds"`

	// Training is whether the operator may train models on what it is sent.
	Training Training `json:"training"`

	// Aggregation is whether the operator may aggregate what it is sent.
	Aggregation Aggregation `json:"aggregation"`

	// Resale is whether the operator may resell what it is sent.
	Resale Resale `json:"resale"`
}

// Custody is a custody level, which states whose machine may hold an end-user's data while it is processed.
type Custody string

// HostedModels is whether a hosted third-party model service may be given an end-user's data.
type HostedModels string

// Resale is what an operator may do to resell what it was sent.
type Resale string

// Tolerance is the strictest terms an operator serves under.
// It limits what the operator agrees to and adds nothing to what the operator may do.
// The fields are in wire order.
type Tolerance struct {
	// Custody is the custody level the operator runs at.
	Custody Custody `json:"custody"`

	// RetentionMinSeconds is the shortest time for which the operator is able to keep what it is sent.
	// Zero means the operator is able to keep nothing.
	RetentionMinSeconds uint64 `json:"retention_min_seconds"`

	// Training is the least training that the terms must permit.
	Training Training `json:"training"`

	// Aggregation is the least aggregation that the terms must permit.
	Aggregation Aggregation `json:"aggregation"`

	// Resale is the least resale that the terms must permit.
	Resale Resale `json:"resale"`
}

// Training is what an operator may do to train models on what it was sent.
type Training string

// UnmarshalText sets a to the aggregation value that text spells.
// It returns ErrInvalid for text that is not an aggregation value.
func (a *Aggregation) UnmarshalText(text []byte) error {
	return parse(a, "aggregation", text, aggregations)
}

// UnmarshalText sets c to the custody level that text spells.
// It returns ErrInvalid for text that is not a custody level.
func (c *Custody) UnmarshalText(text []byte) error {
	return parse(c, "custody", text, custodyLevels)
}

// UnmarshalText sets h to the hosted-models value that text spells.
// It returns ErrInvalid for text that is not a hosted-models value.
func (h *HostedModels) UnmarshalText(text []byte) error {
	return parse(h, "hosted_models", text, hostedModels)
}

// UnmarshalText sets r to the resale value that text spells.
// It returns ErrInvalid for text that is not a resale value.
func (r *Resale) UnmarshalText(text []byte) error {
	return parse(r, "resale", text, resales)
}

// UnmarshalText sets t to the training value that text spells.
// It returns ErrInvalid for text that is not a training value.
func (t *Training) UnmarshalText(text []byte) error {
	return parse(t, "training", text, trainings)
}

// Validate reports every field of c that holds a value S-PAL does not allow, each as an ErrInvalid.
// An unset field is not allowed.
func (c Conditions) Validate() error {
	var errs []error

	if !slices.Contains(custodyLevels, c.Custody) {
		errs = append(errs, invalid("custody", string(c.Custody)))
	}
	if c.RetentionSeconds > MaxSafeInteger {
		errs = append(errs, fmt.Errorf("%w: retention_seconds is above %d", ErrInvalid, uint64(MaxSafeInteger)))
	}
	if !slices.Contains(trainings, c.Training) {
		errs = append(errs, invalid("training", string(c.Training)))
	}
	if !slices.Contains(aggregations, c.Aggregation) {
		errs = append(errs, invalid("aggregation", string(c.Aggregation)))
	}
	if !slices.Contains(resales, c.Resale) {
		errs = append(errs, invalid("resale", string(c.Resale)))
	}

	return errors.Join(errs...)
}

// Validate reports every field of t that holds a value S-PAL does not allow, each as an ErrInvalid.
// An unset field is not allowed.
func (t Tolerance) Validate() error {
	var errs []error

	if !slices.Contains(custodyLevels, t.Custody) {
		errs = append(errs, invalid("custody", string(t.Custody)))
	}
	if t.RetentionMinSeconds > MaxSafeInteger {
		errs = append(errs, fmt.Errorf("%w: retention_min_seconds is above %d", ErrInvalid, uint64(MaxSafeInteger)))
	}
	if !slices.Contains(trainings, t.Training) {
		errs = append(errs, invalid("training", string(t.Training)))
	}
	if !slices.Contains(aggregations, t.Aggregation) {
		errs = append(errs, invalid("aggregation", string(t.Aggregation)))
	}
	if !slices.Contains(resales, t.Resale) {
		errs = append(errs, invalid("resale", string(t.Resale)))
	}

	return errors.Join(errs...)
}

// Within reports whether a permits no more than limit does.
// It reports false when a or limit is not an S-PAL value.
func (a Aggregation) Within(limit Aggregation) bool {
	return within(aggregations, a, limit)
}

// Within reports whether c lets data go no further than ceiling does.
// It reports false when c or ceiling is not an S-PAL value.
func (c Custody) Within(ceiling Custody) bool {
	return within(custodyLevels, c, ceiling)
}

// Within reports whether r permits no more than limit does.
// It reports false when r or limit is not an S-PAL value.
func (r Resale) Within(limit Resale) bool {
	return within(resales, r, limit)
}

// Within reports whether t permits no more than limit does.
// It reports false when t or limit is not an S-PAL value.
func (t Training) Within(limit Training) bool {
	return within(trainings, t, limit)
}

// invalid returns the ErrInvalid for a field that holds a value its type does not have.
func invalid(field string, value string) error {
	if value == "" {
		return fmt.Errorf("%w: %s is not set", ErrInvalid, field)
	}

	return fmt.Errorf("%w: %s is '%s'", ErrInvalid, field, value)
}

// parse sets target to the value that text spells.
// It returns the ErrInvalid for field when text is not one of allowed.
func parse[T ~string](target *T, field string, text []byte, allowed []T) error {
	value := T(text)
	if !slices.Contains(allowed, value) {
		return invalid(field, string(text))
	}
	*target = value

	return nil
}

// within reports whether value comes no later than limit in order.
// It reports false when value or limit is not in order.
func within[T comparable](order []T, value T, limit T) bool {
	at := slices.Index(order, value)
	end := slices.Index(order, limit)

	return at >= 0 && end >= 0 && at <= end
}
