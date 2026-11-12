package spal

import (
	"encoding/json/v2"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConditions_ReadFromJSON(t *testing.T) {
	tests := map[string]struct {
		data    string
		want    Conditions
		wantErr string
	}{
		"every field in its set": {
			data: `{"custody":"community_node","retention_seconds":86400,"training":"requires_payment",` +
				`"aggregation":"anonymized_only","resale":"requires_consent"}`,
			want: Conditions{
				Custody:          CustodyCommunityNode,
				RetentionSeconds: 86400,
				Training:         TrainingRequiresPayment,
				Aggregation:      AggregationAnonymizedOnly,
				Resale:           ResaleRequiresConsent,
			},
		},
		"a custody level S-PAL does not have": {
			data:    `{"custody":"my_laptop"}`,
			wantErr: "custody is 'my_laptop'",
		},
		"a training value that belongs to aggregation": {
			data:    `{"training":"anonymized_only"}`,
			wantErr: "training is 'anonymized_only'",
		},
		"an aggregation value that belongs to training": {
			data:    `{"aggregation":"requires_payment"}`,
			wantErr: "aggregation is 'requires_payment'",
		},
		"a resale value in capitals": {
			data:    `{"resale":"FORBIDDEN"}`,
			wantErr: "resale is 'FORBIDDEN'",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			var got Conditions
			err := json.Unmarshal([]byte(tc.data), &got)
			if tc.wantErr != "" {
				require.ErrorIs(t, err, ErrInvalid)
				require.ErrorContains(t, err, tc.wantErr)
				return
			}

			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

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

func TestCustody_Within(t *testing.T) {
	// Each level is within itself and every level after it, and within none before it.
	for i, level := range custodyLevels {
		for j, ceiling := range custodyLevels {
			require.Equal(t, i <= j, level.Within(ceiling), "%s within %s", level, ceiling)
		}
	}

	require.Equal(t, 6, len(custodyLevels))
	require.True(t, CustodyDeviceOnly.Within(CustodyOwnedHardware))
	require.True(t, CustodyFederatedOperator.Within(CustodyAttestedEnclave))
	require.False(t, CustodyFederatedOperator.Within(CustodyCommunityNode))
	require.False(t, Custody("").Within(CustodyAny))
	require.False(t, CustodyDeviceOnly.Within(Custody("anywhere")))
}

func TestHostedModels_ReadFromText(t *testing.T) {
	var got HostedModels
	require.NoError(t, got.UnmarshalText([]byte("allowed")))
	require.Equal(t, HostedModelsAllowed, got)

	err := got.UnmarshalText([]byte("sometimes"))
	require.ErrorIs(t, err, ErrInvalid)
	require.Equal(t, HostedModelsAllowed, got, "a refused value leaves the target as it was")
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
