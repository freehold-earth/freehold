package terms

import (
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/spec/schemas"
)

func TestAllows(t *testing.T) {
	// The rule permits a federated operator, one hour of retention, training, and aggregation.
	// It has no resale condition.
	terms, err := Parse([]byte(testRules(t, `{
		"custody":{"operator":"federated_operator"},
		"retention":{"max_seconds":3600},
		"derivatives":{"training":"allowed","aggregation":"allowed"}}`)))
	require.NoError(t, err)
	limits, err := terms.Limits("a")
	require.NoError(t, err)

	tests := map[string]struct {
		change  func(c *spal.Conditions)
		wantErr string
	}{
		"a value S-PAL does not have, which the error does not repeat": {
			change:  func(c *spal.Conditions) { c.Custody = "my_laptop" },
			wantErr: "a condition is not a value S-PAL allows for it",
		},
		"aggregation anonymized only, where the rule says allowed": {
			// The tolerance order ranks this value as stricter.
			// A commitment must state the rule's value or forbidden.
			change:  func(c *spal.Conditions) { c.Aggregation = spal.AggregationAnonymizedOnly },
			wantErr: "aggregation is anonymized_only, where the rule says allowed",
		},
		"conditions left unset": {
			change:  func(c *spal.Conditions) { *c = spal.Conditions{} },
			wantErr: "a condition is not a value S-PAL allows for it",
		},
		"custody at the rule's ceiling": {
			change: func(c *spal.Conditions) { c.Custody = spal.CustodyFederatedOperator },
		},
		"custody beyond the rule's ceiling": {
			change:  func(c *spal.Conditions) { c.Custody = spal.CustodyAttestedEnclave },
			wantErr: "custody is attested_enclave, beyond the rule's federated_operator",
		},
		"custody nearer than the rule's ceiling": {
			change: func(c *spal.Conditions) { c.Custody = spal.CustodyDeviceOnly },
		},
		"each derivative as the rule says": {
			change: func(c *spal.Conditions) {
				c.Training = spal.TrainingAllowed
				c.Aggregation = spal.AggregationAllowed
			},
		},
		"resale with consent, where the rule says nothing": {
			change:  func(c *spal.Conditions) { c.Resale = spal.ResaleRequiresConsent },
			wantErr: "resale is requires_consent, where the rule says forbidden",
		},
		"retention a second longer than the rule allows": {
			change:  func(c *spal.Conditions) { c.RetentionSeconds = 3601 },
			wantErr: "retention is 3601 seconds, above the rule's 3600",
		},
		"retention as long as the rule allows": {change: func(c *spal.Conditions) { c.RetentionSeconds = 3600 }},
		"the strictest conditions":             {change: func(*spal.Conditions) {}},
		"training for payment, where the rule says allowed": {
			// The tolerance order ranks this value as stricter.
			// A commitment must state the rule's value or forbidden.
			change:  func(c *spal.Conditions) { c.Training = spal.TrainingRequiresPayment },
			wantErr: "training is requires_payment, where the rule says allowed",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			committed := spal.Conditions{
				Custody:     spal.CustodyCommunityNode,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			}
			tc.change(&committed)

			err := limits.Allows(committed)
			if tc.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.EqualError(t, err, tc.wantErr)
		})
	}
}

func TestAllows_NoLimits(t *testing.T) {
	// The zero Limits rejects even the strictest conditions.
	err := Limits{}.Allows(spal.Conditions{
		Custody:     spal.CustodyDeviceOnly,
		Training:    spal.TrainingForbidden,
		Aggregation: spal.AggregationForbidden,
		Resale:      spal.ResaleForbidden,
	})
	require.EqualError(t, err, "no rule permits anything")
}

func TestAllows_SpecVectors(t *testing.T) {
	var file struct {
		Vectors []struct {
			Commitment *spal.Conditions `json:"commitment"`
			Name       string           `json:"name"`
			Overclaims []struct {
				Conditions spal.Conditions `json:"conditions"`
				Name       string          `json:"name"`
			} `json:"overclaims"`
			Scope     string         `json:"context_scope"`
			Terms     jsontext.Value `json:"terms"`
			Tolerance spal.Tolerance `json:"tolerance"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(schemas.CommitmentVectors(), &file))

	served, overclaims := 0, 0
	for _, tc := range file.Vectors {
		if tc.Commitment == nil {
			continue
		}
		served++

		t.Run(tc.Name, func(t *testing.T) {
			terms, err := Parse(tc.Terms)
			require.NoError(t, err)
			limits, err := terms.Limits(tc.Scope)
			require.NoError(t, err)

			// What an operator commits to under a rule is within the rule's limits.
			commitment, err := terms.Commitment(tc.Scope, tc.Tolerance)
			require.NoError(t, err)
			require.NoError(t, limits.Allows(commitment))

			for _, overclaim := range tc.Overclaims {
				overclaims++
				require.Error(t, limits.Allows(overclaim.Conditions), overclaim.Name)
			}
		})
	}
	require.NotZero(t, served, "the specification's served vectors were not found")
	require.NotZero(t, overclaims, "the specification's overclaims were not found")
}

func TestCommitment_GoverningRule(t *testing.T) {
	// Only the rule for "notes/public" permits a federated operator, so a refusal shows which rule governed.
	const written = `{"version":"1.1","rules":[
		{"context_scope":"notes","conditions":{"custody":{"operator":"device_only"}}},
		{"context_scope":"notes/public","conditions":{"custody":{"operator":"federated_operator"}}},
		{"context_scope":"notes/public","conditions":{"custody":{"operator":"device_only"}}},
		{"context_scope":"notes/public/drafts/old","conditions":{"custody":{"operator":"device_only"}}}
	]}`

	tests := map[string]struct {
		scope string
		want  *Refusal
	}{
		"a more specific rule wins over the one above it": {
			scope: "notes/public/drafts/old",
			want:  &Refusal{Condition: "custody", Reason: ReasonCannotHonor},
		},
		"a scope above every rule": {
			scope: "",
			want:  &Refusal{Reason: ReasonScopeNotGoverned},
		},
		"a scope no rule is near": {
			scope: "health/allergies",
			want:  &Refusal{Reason: ReasonScopeNotGoverned},
		},
		"a scope that only shares a prefix of a name is not under it": {
			scope: "notes-archive",
			want:  &Refusal{Reason: ReasonScopeNotGoverned},
		},
		"the nearest scope above, when the scope has no rule": {
			scope: "notes/public/drafts",
		},
		"the rule for the scope itself, the first of two": {
			scope: "notes/public",
		},
		"the top rule, for a scope only it is above": {
			scope: "notes/private",
			want:  &Refusal{Condition: "custody", Reason: ReasonCannotHonor},
		},
	}

	terms, err := Parse([]byte(written))
	require.NoError(t, err)

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := terms.Commitment(tc.scope, testTolerance(t, nil))
			testRequireRefusal(t, tc.want, err)
		})
	}
}

func TestCommitment_Honor(t *testing.T) {
	tests := map[string]struct {
		change     func(tolerance *spal.Tolerance)
		conditions string
		want       spal.Conditions
		wantErr    *Refusal
	}{
		"a derivative the rule leaves out is forbidden": {
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"allowed"}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingAllowed,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"a derivative the rule leaves out, which the operator needs": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Resale = spal.ResaleRequiresConsent },
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"allowed"}}`,
			wantErr:    &Refusal{Condition: "resale", Reason: ReasonCannotHonor},
		},
		"a retention condition with no limit commits to keeping nothing": {
			conditions: `{"custody":{"operator":"any"},"retention":{"audit_log":true}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"a retention condition with no limit lets nothing be kept": {
			change:     func(tolerance *spal.Tolerance) { tolerance.RetentionMinSeconds = 1 },
			conditions: `{"custody":{"operator":"any"},"retention":{"audit_log":true}}`,
			wantErr:    &Refusal{Condition: "retention", Reason: ReasonCannotHonor},
		},
		"a retention limit of none at all, which the operator cannot keep to": {
			change:     func(tolerance *spal.Tolerance) { tolerance.RetentionMinSeconds = 1 },
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":0}}`,
			wantErr:    &Refusal{Condition: "retention", Reason: ReasonCannotHonor},
		},
		"a retention limit shorter than the operator can keep to": {
			change:     func(tolerance *spal.Tolerance) { tolerance.RetentionMinSeconds = 3601 },
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":3600}}`,
			wantErr:    &Refusal{Condition: "retention", Reason: ReasonCannotHonor},
		},
		"a retention limit that is the shortest the operator can keep to": {
			change:     func(tolerance *spal.Tolerance) { tolerance.RetentionMinSeconds = 3600 },
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":3600}}`,
			want: spal.Conditions{
				Custody:          spal.CustodyFederatedOperator,
				RetentionSeconds: 3600,
				Training:         spal.TrainingForbidden,
				Aggregation:      spal.AggregationForbidden,
				Resale:           spal.ResaleForbidden,
			},
		},
		"a rule silent on custody keeps data on hardware the end-user owns": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Custody = spal.CustodyCommunityNode },
			conditions: `{}`,
			wantErr:    &Refusal{Condition: "custody", Reason: ReasonCannotHonor},
		},
		"a rule that asks nothing, on hardware the end-user owns, is kept to the strictest": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Custody = spal.CustodyOwnedHardware },
			conditions: `{}`,
			want: spal.Conditions{
				Custody:     spal.CustodyOwnedHardware,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"a rule that permits more than the operator needs is still the commitment": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Training = spal.TrainingRequiresPayment },
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"allowed"}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingAllowed,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"aggregation forbidden, where the operator needs it anonymized": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Aggregation = spal.AggregationAnonymizedOnly },
			conditions: `{"custody":{"operator":"any"},"derivatives":{"aggregation":"forbidden"}}`,
			wantErr:    &Refusal{Condition: "aggregation", Reason: ReasonCannotHonor},
		},
		"attestation asked for, which no operator can give yet": {
			conditions: `{"custody":{"operator":"any","attestation_required":true}}`,
			wantErr:    &Refusal{Condition: "attestation", Reason: ReasonCannotHonor},
		},
		"conditions that bind a business are not the operator's": {
			conditions: `{"custody":{"operator":"any"},"identity":{"type":"ephemeral_required"},` +
				`"proofs":[{"type":"zkp","claim":"age_over","params":{"min":18}}],` +
				`"payment":{"protocol":"x402","amount":100,"currency":"sats"}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"custody at the ceiling": {
			conditions: `{"custody":{"operator":"federated_operator"}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"custody beyond the ceiling": {
			conditions: `{"custody":{"operator":"community_node"}}`,
			wantErr:    &Refusal{Condition: "custody", Reason: ReasonCannotHonor},
		},
		"custody is named before attestation": {
			conditions: `{"custody":{"operator":"device_only","attestation_required":true}}`,
			wantErr:    &Refusal{Condition: "custody", Reason: ReasonCannotHonor},
		},
		"custody nearer than the ceiling is the operator's own level": {
			conditions: `{"custody":{"operator":"any"}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"hosted models are not the operator's to answer for": {
			conditions: `{"custody":{"operator":"any","hosted_models":"forbidden","attestation_required":false}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"no derivatives condition forbids what the operator needs": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Training = spal.TrainingRequiresPayment },
			conditions: `{"custody":{"operator":"any"}}`,
			wantErr:    &Refusal{Condition: "training", Reason: ReasonCannotHonor},
		},
		"no retention condition lets nothing be kept": {
			change:     func(tolerance *spal.Tolerance) { tolerance.RetentionMinSeconds = 1 },
			conditions: `{"custody":{"operator":"any"}}`,
			wantErr:    &Refusal{Condition: "retention", Reason: ReasonCannotHonor},
		},
		"retention is named before a derivative": {
			change: func(tolerance *spal.Tolerance) {
				tolerance.RetentionMinSeconds = 60
				tolerance.Training = spal.TrainingAllowed
			},
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":0},` +
				`"derivatives":{"training":"forbidden"}}`,
			wantErr: &Refusal{Condition: "retention", Reason: ReasonCannotHonor},
		},
		"the rule's derivatives are the commitment": {
			conditions: `{"custody":{"operator":"any"},"derivatives":` +
				`{"training":"requires_payment","aggregation":"anonymized_only","resale":"requires_consent"}}`,
			want: spal.Conditions{
				Custody:     spal.CustodyFederatedOperator,
				Training:    spal.TrainingRequiresPayment,
				Aggregation: spal.AggregationAnonymizedOnly,
				Resale:      spal.ResaleRequiresConsent,
			},
		},
		"the rule's retention limit is the commitment": {
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":3600,"audit_log":true}}`,
			want: spal.Conditions{
				Custody:          spal.CustodyFederatedOperator,
				RetentionSeconds: 3600,
				Training:         spal.TrainingForbidden,
				Aggregation:      spal.AggregationForbidden,
				Resale:           spal.ResaleForbidden,
			},
		},
		"training for payment, where the operator needs it free": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Training = spal.TrainingAllowed },
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"requires_payment"}}`,
			wantErr:    &Refusal{Condition: "training", Reason: ReasonCannotHonor},
		},
		"training forbidden, which the operator needs": {
			change:     func(tolerance *spal.Tolerance) { tolerance.Training = spal.TrainingAllowed },
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"forbidden"}}`,
			wantErr:    &Refusal{Condition: "training", Reason: ReasonCannotHonor},
		},
		"training is named before aggregation, and aggregation before resale": {
			change: func(tolerance *spal.Tolerance) {
				tolerance.Training = spal.TrainingAllowed
				tolerance.Aggregation = spal.AggregationAllowed
				tolerance.Resale = spal.ResaleAllowed
			},
			conditions: `{"custody":{"operator":"any"}}`,
			wantErr:    &Refusal{Condition: "training", Reason: ReasonCannotHonor},
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			terms, err := Parse([]byte(testRules(t, tc.conditions)))
			require.NoError(t, err)

			got, err := terms.Commitment("a", testTolerance(t, tc.change))
			testRequireRefusal(t, tc.wantErr, err)
			require.Equal(t, tc.want, got)
		})
	}
}

func TestCommitment_InvalidTolerance(t *testing.T) {
	terms, err := Parse([]byte(testRules(t, `{"custody":{"operator":"any"}}`)))
	require.NoError(t, err)

	// An invalid tolerance is the operator's error, so it is not reported as a refusal.
	_, err = terms.Commitment("a", spal.Tolerance{Custody: spal.CustodyFederatedOperator})
	require.ErrorIs(t, err, spal.ErrInvalid)
	require.ErrorContains(t, err, "training is not set")

	_, refused := errors.AsType[*Refusal](err)
	require.False(t, refused)
}

func TestCommitment_NotUnderstood(t *testing.T) {
	tests := map[string]struct {
		want    string
		written string
	}{
		"a condition S-PAL does not have": {
			want:    "residency",
			written: testRules(t, `{"custody":{"operator":"any"},"residency":{"region":"EU"}}`),
		},
		"a custody condition that is not an object": {
			want:    "custody",
			written: testRules(t, `{"custody":"any"}`),
		},
		"a custody condition that is null": {
			want:    "custody",
			written: testRules(t, `{"custody":null}`),
		},
		"a custody condition without its level": {
			want:    "custody",
			written: testRules(t, `{"custody":{"hosted_models":"forbidden"}}`),
		},
		"a custody level S-PAL does not have": {
			want:    "custody",
			written: testRules(t, `{"custody":{"operator":"my_laptop"}}`),
		},
		"a custody member S-PAL does not have": {
			want:    "custody",
			written: testRules(t, `{"custody":{"operator":"any","region":"EU"}}`),
		},
		"a derivative S-PAL does not have": {
			want:    "derivatives",
			written: testRules(t, `{"derivatives":{"training":"forbidden","profiling":"forbidden"}}`),
		},
		"a derivative value that belongs to another derivative": {
			want:    "derivatives",
			written: testRules(t, `{"derivatives":{"training":"anonymized_only"}}`),
		},
		"a fault in a rule that does not govern the request": {
			want: "residency",
			written: `{"version":"1.1","rules":[` +
				`{"context_scope":"a","conditions":{}},` +
				`{"context_scope":"elsewhere","conditions":{"residency":{}}}]}`,
		},
		"a hosted-models value S-PAL does not have": {
			want:    "custody",
			written: testRules(t, `{"custody":{"operator":"any","hosted_models":"sometimes"}}`),
		},
		"a member a rule does not have": {
			want:    "expires",
			written: `{"version":"1.1","rules":[{"context_scope":"a","conditions":{},"expires":"2027-01-01"}]}`,
		},
		"a member terms do not have": {
			want:    "jurisdiction",
			written: `{"version":"1.1","rules":[],"jurisdiction":"EU"}`,
		},
		"a retention limit above the safe range": {
			want:    "retention",
			written: testRules(t, `{"retention":{"max_seconds":9007199254740992}}`),
		},
		"a retention limit that is negative": {
			want:    "retention",
			written: testRules(t, `{"retention":{"max_seconds":-1}}`),
		},
		"a retention limit that is not whole": {
			want:    "retention",
			written: testRules(t, `{"retention":{"max_seconds":1.5}}`),
		},
		"a retention limit that is text": {
			want:    "retention",
			written: testRules(t, `{"retention":{"max_seconds":"60"}}`),
		},
		"a retention member S-PAL does not have": {
			want:    "retention",
			written: testRules(t, `{"retention":{"max_seconds":0,"delete_by":"shredding"}}`),
		},
		"a version this package does not know": {
			want:    "version",
			written: `{"version":"2.0","rules":[]}`,
		},
		"attestation that is not yes or no": {
			want:    "custody",
			written: testRules(t, `{"custody":{"operator":"any","attestation_required":"yes"}}`),
		},
		"the first in name order, when there are several": {
			want:    "alpha",
			written: testRules(t, `{"zeta":1,"custody":{"operator":"nowhere"},"alpha":1}`),
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			// Terms that are not understood still parse and have a hash.
			terms, err := Parse([]byte(tc.written))
			require.NoError(t, err)

			want := &Refusal{Condition: tc.want, Reason: ReasonConditionNotUnderstood}
			_, err = terms.Commitment("a", testTolerance(t, nil))
			testRequireRefusal(t, want, err)
		})
	}
}

func TestCommitment_SpecVectors(t *testing.T) {
	var file struct {
		Vectors []struct {
			Commitment *spal.Conditions `json:"commitment"`
			Name       string           `json:"name"`
			Refusal    *struct {
				Condition string `json:"condition"`
				Reason    Reason `json:"reason"`
			} `json:"refusal"`
			Scope     string         `json:"context_scope"`
			Terms     jsontext.Value `json:"terms"`
			Tolerance spal.Tolerance `json:"tolerance"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(schemas.CommitmentVectors(), &file))
	require.NotEmpty(t, file.Vectors)

	for _, tc := range file.Vectors {
		t.Run(tc.Name, func(t *testing.T) {
			require.True(t, (tc.Commitment == nil) != (tc.Refusal == nil), "a vector is served or refused")

			terms, err := Parse(tc.Terms)
			require.NoError(t, err)

			got, err := terms.Commitment(tc.Scope, tc.Tolerance)
			if tc.Refusal != nil {
				testRequireRefusal(t, &Refusal{Condition: tc.Refusal.Condition, Reason: tc.Refusal.Reason}, err)
				return
			}

			require.NoError(t, err)
			require.Equal(t, *tc.Commitment, got)
		})
	}
}

func TestLimits(t *testing.T) {
	const written = `{"version":"1.1","rules":[
		{"context_scope":"silent","conditions":{}},
		{"context_scope":"stated","conditions":{
			"custody":{"operator":"federated_operator","attestation_required":false},
			"retention":{"max_seconds":3600},
			"derivatives":{"training":"requires_payment","aggregation":"allowed","resale":"requires_consent"}}},
		{"context_scope":"partly","conditions":{
			"custody":{"operator":"any"},
			"retention":{"audit_log":true},
			"derivatives":{"aggregation":"anonymized_only"}}},
		{"context_scope":"attested","conditions":{"custody":{"operator":"any","attestation_required":true}}}
	]}`

	tests := map[string]struct {
		scope   string
		want    spal.Conditions
		wantErr *Refusal
	}{
		"a rule that asks for attestation, which no operator can give": {
			scope:   "attested",
			wantErr: &Refusal{Condition: "attestation", Reason: ReasonCannotHonor},
		},
		"a rule that says nothing permits the least": {
			scope: "silent",
			want: spal.Conditions{
				Custody:     spal.CustodyOwnedHardware,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationForbidden,
				Resale:      spal.ResaleForbidden,
			},
		},
		"a rule that states everything permits what it states": {
			scope: "stated",
			want: spal.Conditions{
				Custody:          spal.CustodyFederatedOperator,
				RetentionSeconds: 3600,
				Training:         spal.TrainingRequiresPayment,
				Aggregation:      spal.AggregationAllowed,
				Resale:           spal.ResaleRequiresConsent,
			},
		},
		"a scope no rule governs": {
			scope:   "health",
			wantErr: &Refusal{Reason: ReasonScopeNotGoverned},
		},
		"the nearest scope above, when the scope has no rule": {
			scope: "partly/2026/drafts",
			want: spal.Conditions{
				Custody:     spal.CustodyAny,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationAnonymizedOnly,
				Resale:      spal.ResaleForbidden,
			},
		},
		"what a rule leaves out of a condition it states is not permitted": {
			scope: "partly",
			want: spal.Conditions{
				Custody:     spal.CustodyAny,
				Training:    spal.TrainingForbidden,
				Aggregation: spal.AggregationAnonymizedOnly,
				Resale:      spal.ResaleForbidden,
			},
		},
	}

	terms, err := Parse([]byte(written))
	require.NoError(t, err)

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			got, err := terms.Limits(tc.scope)
			testRequireRefusal(t, tc.wantErr, err)
			require.Equal(t, Limits{most: tc.want}, got)
		})
	}
}

func TestLimits_NotUnderstood(t *testing.T) {
	terms, err := Parse([]byte(testRules(t, `{"residency":{}}`)))
	require.NoError(t, err)

	got, err := terms.Limits("a")
	testRequireRefusal(t, &Refusal{Condition: "residency", Reason: ReasonConditionNotUnderstood}, err)
	require.Empty(t, got)
}

func TestParse_HashCoversEveryMember(t *testing.T) {
	plain, err := Parse([]byte(`{"version":"1.1","rules":[]}`))
	require.NoError(t, err)

	// An unknown member changes the terms, and so changes the hash.
	extended, err := Parse([]byte(`{"version":"1.1","rules":[],"jurisdiction":"EU"}`))
	require.NoError(t, err)
	require.NotEqual(t, plain.Hash(), extended.Hash())

	// Different spacing and member order do not change the hash.
	respaced, err := Parse([]byte("{ \"rules\" : [ ],\n\t\"version\" : \"1.1\" }"))
	require.NoError(t, err)
	require.Equal(t, plain.Hash(), respaced.Hash())
}

func TestParse_Malformed(t *testing.T) {
	tests := map[string]struct {
		written string
	}{
		"a member named twice":         {written: `{"version":"1.1","version":"1.0","rules":[]}`},
		"a rule that is not an object": {written: `{"version":"1.1","rules":["notes"]}`},
		"a rule with an empty scope":   {written: `{"version":"1.1","rules":[{"context_scope":"","conditions":{}}]}`},
		"a rule without a scope":       {written: `{"version":"1.1","rules":[{"conditions":{}}]}`},
		"a rule without conditions":    {written: `{"version":"1.1","rules":[{"context_scope":"a"}]}`},
		"a scope that is not text":     {written: `{"version":"1.1","rules":[{"context_scope":7,"conditions":{}}]}`},
		"a version that is not text":   {written: `{"version":1.1,"rules":[]}`},
		"an array":                     {written: `[]`},
		"conditions that are not an object": {
			written: `{"version":"1.1","rules":[{"context_scope":"a","conditions":[]}]}`,
		},
		"no rules":                  {written: `{"version":"1.1"}`},
		"no version":                {written: `{"rules":[]}`},
		"not JSON":                  {written: `{"version":`},
		"nothing":                   {written: ``},
		"null":                      {written: `null`},
		"rules that are not a list": {written: `{"version":"1.1","rules":{}}`},
		"rules that are null":       {written: `{"version":"1.1","rules":null}`},
		"text":                      {written: `"terms"`},
		"text that is not UTF-8":    {written: "{\"version\":\"1.1\",\"rules\":[],\"x\":\"\xff\"}"},
		"two objects":               {written: `{"version":"1.1","rules":[]}{}`},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			terms, err := Parse([]byte(tc.written))
			require.Nil(t, terms)
			testRequireRefusal(t, &Refusal{Reason: ReasonTermsMalformed}, err)
		})
	}
}

func TestParse_SpecVectors(t *testing.T) {
	var file struct {
		Vectors []struct {
			Name               string `json:"name"`
			TermsCanonicalJSON string `json:"terms_canonical_json"`
			TermsHash          string `json:"terms_hash"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(schemas.TermsVectors(), &file))
	require.NotEmpty(t, file.Vectors)

	for _, tc := range file.Vectors {
		t.Run(tc.Name, func(t *testing.T) {
			terms, err := Parse([]byte(tc.TermsCanonicalJSON))
			require.NoError(t, err)
			hash := terms.Hash()
			require.Equal(t, tc.TermsHash, hex.EncodeToString(hash[:]))

			// Different spacing does not change the hash.
			indented := jsontext.Value(tc.TermsCanonicalJSON)
			require.NoError(t, indented.Indent())
			again, err := Parse(indented)
			require.NoError(t, err)
			require.Equal(t, terms.Hash(), again.Hash())

			// Every vector is understood, so no scope is refused as not understood.
			_, err = terms.Commitment("personal/age", testTolerance(t, nil))
			if refusal, refused := errors.AsType[*Refusal](err); refused {
				require.NotEqual(t, ReasonConditionNotUnderstood, refusal.Reason)
			}
		})
	}
}

func TestRefusal_Error(t *testing.T) {
	tests := map[string]struct {
		refusal Refusal
		want    string
	}{
		"a reason alone": {
			refusal: Refusal{Reason: ReasonTermsUnknown},
			want:    "terms refused: terms_unknown",
		},
		"a reason and what it is about": {
			refusal: Refusal{Condition: "custody", Reason: ReasonCannotHonor},
			want:    "terms refused: cannot_honour: custody",
		},
		"a reason, what it is about and what was found": {
			refusal: Refusal{
				Reason:    ReasonConditionNotUnderstood,
				Condition: "custody",
				cause:     errors.New("operator is missing"),
			},
			want: "terms refused: condition_not_understood: custody: operator is missing",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			require.EqualError(t, &tc.refusal, tc.want)
		})
	}
}

func TestRefusal_KeepsWhatWasFound(t *testing.T) {
	terms, err := Parse([]byte(testRules(t, `{"custody":{"operator":"my_laptop"}}`)))
	require.NoError(t, err)

	// The error names the condition and keeps the invalid value as its cause.
	_, err = terms.Commitment("a", testTolerance(t, nil))
	require.ErrorIs(t, err, spal.ErrInvalid)
	require.ErrorContains(t, err, "the rule for a")
	require.ErrorContains(t, err, "custody is 'my_laptop'")

	_, err = Parse([]byte(`{"version":"1.1"}`))
	require.ErrorContains(t, err, "terms_malformed: rules is missing")
}

// testRequireRefusal fails the test unless err matches want, where a nil want means no error.
func testRequireRefusal(t *testing.T, want *Refusal, err error) {
	t.Helper()

	if want == nil {
		require.NoError(t, err)
		return
	}

	got, ok := errors.AsType[*Refusal](err)
	require.True(t, ok, "want a refusal, got %v", err)
	require.Equal(t, want.Reason, got.Reason)
	require.Equal(t, want.Condition, got.Condition)
}

// testRules returns terms with one rule for the scope "a" that holds conditions.
func testRules(t *testing.T, conditions string) string {
	t.Helper()

	return `{"version":"1.1","rules":[{"context_scope":"a","conditions":` + conditions + `}]}`
}

// testTolerance returns the most permissive tolerance of a federated operator, with change applied.
func testTolerance(t *testing.T, change func(tolerance *spal.Tolerance)) spal.Tolerance {
	t.Helper()

	tolerance := spal.Tolerance{
		Custody:             spal.CustodyFederatedOperator,
		RetentionMinSeconds: 0,
		Training:            spal.TrainingForbidden,
		Aggregation:         spal.AggregationForbidden,
		Resale:              spal.ResaleForbidden,
	}
	if change != nil {
		change(&tolerance)
	}

	return tolerance
}
