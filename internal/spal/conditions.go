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

// Resale is what an operator may do to sell on what it was sent.
type Resale string

// Training is what an operator may do to train models on what it was sent.
type Training string

// Validate reports every field of c that holds a value S-PAL does not allow, each as an ErrInvalid.
//
// A field left unset is not allowed: an operator states all five.
func (c Conditions) Validate() error {
	var errs []error

	if !slices.Contains(
		[]Custody{
			CustodyDeviceOnly,
			CustodyOwnedHardware,
			CustodyCommunityNode,
			CustodyFederatedOperator,
			CustodyAttestedEnclave,
			CustodyAny,
		},
		c.Custody,
	) {
		errs = append(errs, invalid("custody", string(c.Custody)))
	}
	if c.RetentionSeconds > MaxSafeInteger {
		errs = append(errs, fmt.Errorf("%w: retention_seconds is above %d", ErrInvalid, uint64(MaxSafeInteger)))
	}
	if !slices.Contains([]Training{TrainingAllowed, TrainingForbidden, TrainingRequiresPayment}, c.Training) {
		errs = append(errs, invalid("training", string(c.Training)))
	}
	if !slices.Contains(
		[]Aggregation{AggregationAllowed, AggregationAnonymizedOnly, AggregationForbidden},
		c.Aggregation,
	) {
		errs = append(errs, invalid("aggregation", string(c.Aggregation)))
	}
	if !slices.Contains([]Resale{ResaleAllowed, ResaleForbidden, ResaleRequiresConsent}, c.Resale) {
		errs = append(errs, invalid("resale", string(c.Resale)))
	}

	return errors.Join(errs...)
}

// invalid returns the ErrInvalid for a field holding a value its type does not have.
func invalid(field string, value string) error {
	if value == "" {
		return fmt.Errorf("%w: %s is not set", ErrInvalid, field)
	}

	return fmt.Errorf("%w: %s is '%s'", ErrInvalid, field, value)
}
