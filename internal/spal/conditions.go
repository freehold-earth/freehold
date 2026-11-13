package spal

import (
	"errors"
	"fmt"
	"slices"
)

// MaxSafeInteger is the largest integer S-PAL carries: 2^53 - 1, the largest every implementation holds exactly.
const MaxSafeInteger = 1<<53 - 1

// What may be done with aggregates of what an operator was sent.
const (
	// AggregationAllowed permits aggregation.
	AggregationAllowed Aggregation = "allowed"

	// AggregationAnonymizedOnly permits aggregation of anonymized data only.
	AggregationAnonymizedOnly Aggregation = "anonymized_only"

	// AggregationForbidden permits no aggregation.
	AggregationForbidden Aggregation = "forbidden"
)

// The custody levels, from the one that keeps data closest to its holder to the one that lets it go furthest.
const (
	// CustodyDeviceOnly keeps the data on the holder's own device.
	CustodyDeviceOnly Custody = "device_only"

	// CustodyOwnedHardware keeps the data on hardware the holder owns.
	CustodyOwnedHardware Custody = "owned_hardware"

	// CustodyCommunityNode lets the data reach a node run by someone the holder knows.
	CustodyCommunityNode Custody = "community_node"

	// CustodyFederatedOperator lets the data reach an operator answerable through community governance.
	CustodyFederatedOperator Custody = "federated_operator"

	// CustodyAttestedEnclave lets the data reach any operator that proves what it runs.
	CustodyAttestedEnclave Custody = "attested_enclave"

	// CustodyAny lets the data reach any operator.
	CustodyAny Custody = "any"
)

// Whether a hosted third-party model may be given a person's data.
const (
	// HostedModelsAllowed lets a hosted model service receive the data.
	HostedModelsAllowed HostedModels = "allowed"

	// HostedModelsForbidden keeps the data from any hosted model service.
	HostedModelsForbidden HostedModels = "forbidden"
)

// What may be done to sell on what an operator was sent.
const (
	// ResaleAllowed permits resale.
	ResaleAllowed Resale = "allowed"

	// ResaleForbidden permits no resale.
	ResaleForbidden Resale = "forbidden"

	// ResaleRequiresConsent permits resale only with the holder's consent.
	ResaleRequiresConsent Resale = "requires_consent"
)

// What may be done to train models on what an operator was sent.
const (
	// TrainingAllowed permits training.
	TrainingAllowed Training = "allowed"

	// TrainingForbidden permits no training.
	TrainingForbidden Training = "forbidden"

	// TrainingRequiresPayment permits training only against payment.
	TrainingRequiresPayment Training = "requires_payment"
)

var (
	// aggregations are the values an Aggregation may hold, from the one that permits least to the one that permits
	// most.
	aggregations = []Aggregation{AggregationForbidden, AggregationAnonymizedOnly, AggregationAllowed}

	// custodyLevels are the values a Custody may hold, from the level that keeps data closest to its holder to the
	// one that lets it go furthest. The order is the one S-PAL compares custody levels by.
	custodyLevels = []Custody{
		CustodyDeviceOnly,
		CustodyOwnedHardware,
		CustodyCommunityNode,
		CustodyFederatedOperator,
		CustodyAttestedEnclave,
		CustodyAny,
	}

	// hostedModels are the values a HostedModels may hold.
	hostedModels = []HostedModels{HostedModelsAllowed, HostedModelsForbidden}

	// resales are the values a Resale may hold, from the one that permits least to the one that permits most.
	resales = []Resale{ResaleForbidden, ResaleRequiresConsent, ResaleAllowed}

	// trainings are the values a Training may hold, from the one that permits least to the one that permits most.
	trainings = []Training{TrainingForbidden, TrainingRequiresPayment, TrainingAllowed}
)

// Aggregation is what an operator may do with aggregates of what it was sent.
type Aggregation string

// Conditions is what an operator commits to for a request it serves.
type Conditions struct {
	// Custody is the custody level the operator runs at.
	Custody Custody `json:"custody"`

	// RetentionSeconds is how long the operator keeps what it is sent; zero is not at all.
	RetentionSeconds uint64 `json:"retention_seconds"`

	// Training is whether the operator may train models on what it is sent.
	Training Training `json:"training"`

	// Aggregation is whether the operator may aggregate what it is sent.
	Aggregation Aggregation `json:"aggregation"`

	// Resale is whether the operator may sell on what it is sent.
	Resale Resale `json:"resale"`
}

// Custody is a custody level: whose machine may hold a person's data while it is worked on.
type Custody string

// HostedModels is whether a hosted third-party model service may be given a person's data.
type HostedModels string

// Resale is what an operator may do to sell on what it was sent.
type Resale string

// Tolerance is the strictest terms an operator serves under. It limits what the operator agrees to and adds nothing
// to what it may do: a request is served under its own terms or refused.
type Tolerance struct {
	// Custody is the custody level the operator runs at.
	Custody Custody `json:"custody"`

	// RetentionMinSeconds is the shortest time the operator is able to keep what it is sent for; zero is not at all.
	RetentionMinSeconds uint64 `json:"retention_min_seconds"`

	// Training is the least the terms must permit by way of training.
	Training Training `json:"training"`

	// Aggregation is the least the terms must permit by way of aggregation.
	Aggregation Aggregation `json:"aggregation"`

	// Resale is the least the terms must permit by way of resale.
	Resale Resale `json:"resale"`
}

// Training is what an operator may do to train models on what it was sent.
type Training string

// UnmarshalText reads an aggregation value, and returns ErrInvalid for text that is not one.
func (a *Aggregation) UnmarshalText(text []byte) error {
	return parse(a, "aggregation", text, aggregations)
}

// UnmarshalText reads a custody level, and returns ErrInvalid for text that is not one.
func (c *Custody) UnmarshalText(text []byte) error {
	return parse(c, "custody", text, custodyLevels)
}

// UnmarshalText reads a hosted-models value, and returns ErrInvalid for text that is not one.
func (h *HostedModels) UnmarshalText(text []byte) error {
	return parse(h, "hosted_models", text, hostedModels)
}

// UnmarshalText reads a resale value, and returns ErrInvalid for text that is not one.
func (r *Resale) UnmarshalText(text []byte) error {
	return parse(r, "resale", text, resales)
}

// UnmarshalText reads a training value, and returns ErrInvalid for text that is not one.
func (t *Training) UnmarshalText(text []byte) error {
	return parse(t, "training", text, trainings)
}

// Validate reports every field of c that holds a value S-PAL does not allow, each as an ErrInvalid.
//
// A field left unset is not allowed.
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
//
// A field left unset is not allowed.
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
//
// A value S-PAL does not have is within nothing, and nothing is within it.
func (a Aggregation) Within(limit Aggregation) bool {
	return within(aggregations, a, limit)
}

// Within reports whether c lets data go no further than ceiling does.
//
// A level S-PAL does not have is within nothing, and nothing is within it.
func (c Custody) Within(ceiling Custody) bool {
	return within(custodyLevels, c, ceiling)
}

// Within reports whether r permits no more than limit does.
//
// A value S-PAL does not have is within nothing, and nothing is within it.
func (r Resale) Within(limit Resale) bool {
	return within(resales, r, limit)
}

// Within reports whether t permits no more than limit does.
//
// A value S-PAL does not have is within nothing, and nothing is within it.
func (t Training) Within(limit Training) bool {
	return within(trainings, t, limit)
}

// invalid returns the ErrInvalid for a field holding a value its type does not have.
func invalid(field string, value string) error {
	if value == "" {
		return fmt.Errorf("%w: %s is not set", ErrInvalid, field)
	}

	return fmt.Errorf("%w: %s is '%s'", ErrInvalid, field, value)
}

// parse sets target to the value text spells, or returns the ErrInvalid for a field holding text that is not one of
// allowed.
func parse[T ~string](target *T, field string, text []byte, allowed []T) error {
	value := T(text)
	if !slices.Contains(allowed, value) {
		return invalid(field, string(text))
	}
	*target = value

	return nil
}

// within reports whether value comes no later than limit in order. A value that is not in order is within nothing,
// and nothing is within it.
func within[T comparable](order []T, value T, limit T) bool {
	at := slices.Index(order, value)
	end := slices.Index(order, limit)

	return at >= 0 && end >= 0 && at <= end
}
