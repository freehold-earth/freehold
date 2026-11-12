package spal

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConditions_Validate(t *testing.T) {
	tests := map[string]struct {
		change  func(c *Conditions)
		wantErr []string
	}{
		"strictest": {
			change: func(*Conditions) {},
		},
		"most permissive": {
			change: func(c *Conditions) {
				*c = Conditions{
					Custody:          CustodyAny,
					RetentionSeconds: MaxSafeInteger,
					Training:         TrainingAllowed,
					Aggregation:      AggregationAllowed,
					Resale:           ResaleAllowed,
				}
			},
		},
		"each field's own third value": {
			change: func(c *Conditions) {
				c.Training = TrainingRequiresPayment
				c.Aggregation = AggregationAnonymizedOnly
				c.Resale = ResaleRequiresConsent
			},
		},
		"custody not set": {
			change:  func(c *Conditions) { c.Custody = "" },
			wantErr: []string{"custody is not set"},
		},
		"custody spelled another way": {
			change:  func(c *Conditions) { c.Custody = "Federated_Operator" },
			wantErr: []string{"custody is 'Federated_Operator'"},
		},
		"retention above the safe range": {
			change:  func(c *Conditions) { c.RetentionSeconds = MaxSafeInteger + 1 },
			wantErr: []string{"retention_seconds is above 9007199254740991"},
		},
		"a value that belongs to another field": {
			change:  func(c *Conditions) { c.Training = "anonymized_only" },
			wantErr: []string{"training is 'anonymized_only'"},
		},
		"every fault is reported": {
			change: func(c *Conditions) {
				c.Aggregation = "requires_payment"
				c.Resale = ""
			},
			wantErr: []string{"aggregation is 'requires_payment'", "resale is not set"},
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			conditions := testStrictConditions(t)
			tc.change(&conditions)

			err := conditions.Validate()
			if len(tc.wantErr) == 0 {
				require.NoError(t, err)
				return
			}

			require.ErrorIs(t, err, ErrInvalid)
			for _, want := range tc.wantErr {
				require.ErrorContains(t, err, want)
			}
		})
	}
}

// testStrictConditions returns the conditions of an operator that keeps nothing and derives nothing.
func testStrictConditions(t *testing.T) Conditions {
	t.Helper()

	return Conditions{
		Custody:          CustodyFederatedOperator,
		RetentionSeconds: 0,
		Training:         TrainingForbidden,
		Aggregation:      AggregationForbidden,
		Resale:           ResaleForbidden,
	}
}
