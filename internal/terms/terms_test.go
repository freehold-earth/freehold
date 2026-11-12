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

func TestCheck_GoverningRule(t *testing.T) {
	// Only the rule for "notes/public" lets data reach a federated operator, so which rule governed shows in
	// whether that operator is refused.
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
		"the rule for the scope itself, the first of two": {
			scope: "notes/public",
		},
		"the nearest scope above, when the scope has no rule": {
			scope: "notes/public/drafts",
		},
		"a more specific rule wins over the one above it": {
			scope: "notes/public/drafts/old",
			want:  &Refusal{Reason: ReasonCannotHonor, Condition: "custody"},
		},
		"the top rule, for a scope only it is above": {
			scope: "notes/private",
			want:  &Refusal{Reason: ReasonCannotHonor, Condition: "custody"},
		},
		"a scope that only shares a prefix of a name is not under it": {
			scope: "notes-archive",
			want:  &Refusal{Reason: ReasonScopeNotGoverned},
		},
		"a scope above every rule": {
			scope: "",
			want:  &Refusal{Reason: ReasonScopeNotGoverned},
		},
		"a scope no rule is near": {
			scope: "health/allergies",
			want:  &Refusal{Reason: ReasonScopeNotGoverned},
		},
	}

	terms, err := Parse([]byte(written))
	require.NoError(t, err)

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			testRequireRefusal(t, tc.want, terms.Check(tc.scope, testOffer(t, nil)))
		})
	}
}

func TestCheck_Honor(t *testing.T) {
	tests := map[string]struct {
		conditions string
		change     func(c *spal.Conditions)
		want       *Refusal
	}{
		"a rule that asks nothing, on hardware its holder owns": {
			conditions: `{}`,
			change:     func(c *spal.Conditions) { c.Custody = spal.CustodyOwnedHardware },
		},
		"a rule silent on custody keeps data on hardware its holder owns": {
			conditions: `{}`,
			change:     func(c *spal.Conditions) { c.Custody = spal.CustodyCommunityNode },
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "custody"},
		},
		"custody at the ceiling": {
			conditions: `{"custody":{"operator":"federated_operator"}}`,
		},
		"custody nearer than the ceiling": {
			conditions: `{"custody":{"operator":"any"}}`,
		},
		"custody beyond the ceiling": {
			conditions: `{"custody":{"operator":"community_node"}}`,
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "custody"},
		},
		"attestation asked for, which no operator can give yet": {
			conditions: `{"custody":{"operator":"any","attestation_required":true}}`,
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "attestation"},
		},
		"custody is named before attestation": {
			conditions: `{"custody":{"operator":"device_only","attestation_required":true}}`,
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "custody"},
		},
		"hosted models are not the operator's to answer for": {
			conditions: `{"custody":{"operator":"any","hosted_models":"forbidden","attestation_required":false}}`,
		},
		"retention at the limit": {
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":3600,"audit_log":true}}`,
			change:     func(c *spal.Conditions) { c.RetentionSeconds = 3600 },
		},
		"retention above the limit": {
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":3600}}`,
			change:     func(c *spal.Conditions) { c.RetentionSeconds = 3601 },
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "retention"},
		},
		"retention above a limit of none at all": {
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":0}}`,
			change:     func(c *spal.Conditions) { c.RetentionSeconds = 1 },
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "retention"},
		},
		"a retention condition with no limit asks nothing": {
			conditions: `{"custody":{"operator":"any"},"retention":{"audit_log":true}}`,
			change:     func(c *spal.Conditions) { c.RetentionSeconds = spal.MaxSafeInteger },
		},
		"no retention condition asks nothing": {
			conditions: `{"custody":{"operator":"any"}}`,
			change:     func(c *spal.Conditions) { c.RetentionSeconds = spal.MaxSafeInteger },
		},
		"derivatives the same as the rule's": {
			conditions: `{"custody":{"operator":"any"},"derivatives":` +
				`{"training":"requires_payment","aggregation":"anonymized_only","resale":"requires_consent"}}`,
			change: func(c *spal.Conditions) {
				c.Training = spal.TrainingRequiresPayment
				c.Aggregation = spal.AggregationAnonymizedOnly
				c.Resale = spal.ResaleRequiresConsent
			},
		},
		"forbidding a derivative keeps any rule about it": {
			conditions: `{"custody":{"operator":"any"},"derivatives":` +
				`{"training":"allowed","aggregation":"anonymized_only","resale":"requires_consent"}}`,
		},
		"training allowed where the rule forbids it": {
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"forbidden"}}`,
			change:     func(c *spal.Conditions) { c.Training = spal.TrainingAllowed },
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "training"},
		},
		"training for payment where the rule allows it freely is not the rule's value": {
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"allowed"}}`,
			change:     func(c *spal.Conditions) { c.Training = spal.TrainingRequiresPayment },
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "training"},
		},
		"aggregation allowed where the rule wants it anonymized": {
			conditions: `{"custody":{"operator":"any"},"derivatives":{"aggregation":"anonymized_only"}}`,
			change:     func(c *spal.Conditions) { c.Aggregation = spal.AggregationAllowed },
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "aggregation"},
		},
		"resale allowed where the rule wants consent": {
			conditions: `{"custody":{"operator":"any"},"derivatives":{"resale":"requires_consent"}}`,
			change:     func(c *spal.Conditions) { c.Resale = spal.ResaleAllowed },
			want:       &Refusal{Reason: ReasonCannotHonor, Condition: "resale"},
		},
		"a derivative the rule leaves out asks nothing": {
			conditions: `{"custody":{"operator":"any"},"derivatives":{"training":"forbidden"}}`,
			change: func(c *spal.Conditions) {
				c.Aggregation = spal.AggregationAllowed
				c.Resale = spal.ResaleAllowed
			},
		},
		"no derivatives condition asks nothing": {
			conditions: `{"custody":{"operator":"any"}}`,
			change: func(c *spal.Conditions) {
				c.Training = spal.TrainingAllowed
				c.Aggregation = spal.AggregationAllowed
				c.Resale = spal.ResaleAllowed
			},
		},
		"conditions that bind a business are not the operator's": {
			conditions: `{"custody":{"operator":"any"},"identity":{"type":"ephemeral_required"},` +
				`"proofs":[{"type":"zkp","claim":"age_over","params":{"min":18}}],` +
				`"payment":{"protocol":"x402","amount":100,"currency":"sats"}}`,
		},
		"retention is named before a derivative": {
			conditions: `{"custody":{"operator":"any"},"retention":{"max_seconds":0},` +
				`"derivatives":{"training":"forbidden"}}`,
			change: func(c *spal.Conditions) {
				c.RetentionSeconds = 60
				c.Training = spal.TrainingAllowed
			},
			want: &Refusal{Reason: ReasonCannotHonor, Condition: "retention"},
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			terms, err := Parse(
				[]byte(`{"version":"1.1","rules":[{"context_scope":"a","conditions":` + tc.conditions + `}]}`),
			)
			require.NoError(t, err)

			testRequireRefusal(t, tc.want, terms.Check("a", testOffer(t, tc.change)))
		})
	}
}

func TestCheck_NotUnderstood(t *testing.T) {
	tests := map[string]struct {
		written string
		want    string
	}{
		"a version this package does not know": {
			written: `{"version":"2.0","rules":[]}`,
			want:    "version",
		},
		"a member terms do not have": {
			written: `{"version":"1.1","rules":[],"jurisdiction":"EU"}`,
			want:    "jurisdiction",
		},
		"a member a rule does not have": {
			written: `{"version":"1.1","rules":[{"context_scope":"a","conditions":{},"expires":"2027-01-01"}]}`,
			want:    "expires",
		},
		"a condition S-PAL does not have": {
			written: testRules(t, `{"custody":{"operator":"any"},"residency":{"region":"EU"}}`),
			want:    "residency",
		},
		"a custody level S-PAL does not have": {
			written: testRules(t, `{"custody":{"operator":"my_laptop"}}`),
			want:    "custody",
		},
		"a custody condition without its level": {
			written: testRules(t, `{"custody":{"hosted_models":"forbidden"}}`),
			want:    "custody",
		},
		"a custody member S-PAL does not have": {
			written: testRules(t, `{"custody":{"operator":"any","region":"EU"}}`),
			want:    "custody",
		},
		"a hosted-models value S-PAL does not have": {
			written: testRules(t, `{"custody":{"operator":"any","hosted_models":"sometimes"}}`),
			want:    "custody",
		},
		"attestation that is not yes or no": {
			written: testRules(t, `{"custody":{"operator":"any","attestation_required":"yes"}}`),
			want:    "custody",
		},
		"a custody condition that is not an object": {
			written: testRules(t, `{"custody":"any"}`),
			want:    "custody",
		},
		"a custody condition that is null": {
			written: testRules(t, `{"custody":null}`),
			want:    "custody",
		},
		"a retention limit that is negative": {
			written: testRules(t, `{"retention":{"max_seconds":-1}}`),
			want:    "retention",
		},
		"a retention limit that is not whole": {
			written: testRules(t, `{"retention":{"max_seconds":1.5}}`),
			want:    "retention",
		},
		"a retention limit that is text": {
			written: testRules(t, `{"retention":{"max_seconds":"60"}}`),
			want:    "retention",
		},
		"a retention limit above the safe range": {
			written: testRules(t, `{"retention":{"max_seconds":9007199254740992}}`),
			want:    "retention",
		},
		"a retention member S-PAL does not have": {
			written: testRules(t, `{"retention":{"max_seconds":0,"delete_by":"shredding"}}`),
			want:    "retention",
		},
		"a derivative value that belongs to another derivative": {
			written: testRules(t, `{"derivatives":{"training":"anonymized_only"}}`),
			want:    "derivatives",
		},
		"a derivative S-PAL does not have": {
			written: testRules(t, `{"derivatives":{"training":"forbidden","profiling":"forbidden"}}`),
			want:    "derivatives",
		},
		"the first in name order, when there are several": {
			written: testRules(t, `{"zeta":1,"custody":{"operator":"nowhere"},"alpha":1}`),
			want:    "alpha",
		},
		"a fault in a rule that does not govern the request": {
			written: `{"version":"1.1","rules":[` +
				`{"context_scope":"a","conditions":{}},` +
				`{"context_scope":"elsewhere","conditions":{"residency":{}}}]}`,
			want: "residency",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			// Terms that are not understood are still terms, with a hash: they are refused when used.
			terms, err := Parse([]byte(tc.written))
			require.NoError(t, err)

			want := &Refusal{Reason: ReasonConditionNotUnderstood, Condition: tc.want}
			testRequireRefusal(t, want, terms.Check("a", testOffer(t, nil)))
		})
	}
}

func TestParse_HashCoversEveryMember(t *testing.T) {
	plain, err := Parse([]byte(`{"version":"1.1","rules":[]}`))
	require.NoError(t, err)

	// Terms with a member this package does not know are different terms, and hash differently.
	extended, err := Parse([]byte(`{"version":"1.1","rules":[],"jurisdiction":"EU"}`))
	require.NoError(t, err)
	require.NotEqual(t, plain.Hash(), extended.Hash())

	// The same terms written another way are the same terms.
	respaced, err := Parse([]byte("{ \"rules\" : [ ],\n\t\"version\" : \"1.1\" }"))
	require.NoError(t, err)
	require.Equal(t, plain.Hash(), respaced.Hash())
}

func TestParse_Malformed(t *testing.T) {
	tests := map[string]struct {
		written string
	}{
		"nothing":                      {written: ``},
		"not JSON":                     {written: `{"version":`},
		"an array":                     {written: `[]`},
		"text":                         {written: `"terms"`},
		"null":                         {written: `null`},
		"two objects":                  {written: `{"version":"1.1","rules":[]}{}`},
		"a member named twice":         {written: `{"version":"1.1","version":"1.0","rules":[]}`},
		"text that is not UTF-8":       {written: "{\"version\":\"1.1\",\"rules\":[],\"x\":\"\xff\"}"},
		"no version":                   {written: `{"rules":[]}`},
		"a version that is not text":   {written: `{"version":1.1,"rules":[]}`},
		"no rules":                     {written: `{"version":"1.1"}`},
		"rules that are null":          {written: `{"version":"1.1","rules":null}`},
		"rules that are not a list":    {written: `{"version":"1.1","rules":{}}`},
		"a rule that is not an object": {written: `{"version":"1.1","rules":["notes"]}`},
		"a rule without a scope":       {written: `{"version":"1.1","rules":[{"conditions":{}}]}`},
		"a rule with an empty scope":   {written: `{"version":"1.1","rules":[{"context_scope":"","conditions":{}}]}`},
		"a scope that is not text":     {written: `{"version":"1.1","rules":[{"context_scope":7,"conditions":{}}]}`},
		"a rule without conditions":    {written: `{"version":"1.1","rules":[{"context_scope":"a"}]}`},
		"conditions that are not an object": {
			written: `{"version":"1.1","rules":[{"context_scope":"a","conditions":[]}]}`,
		},
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

			// Written with other spacing, the terms are the same terms.
			indented := jsontext.Value(tc.TermsCanonicalJSON)
			require.NoError(t, indented.Indent())
			again, err := Parse(indented)
			require.NoError(t, err)
			require.Equal(t, terms.Hash(), again.Hash())

			// Every vector is terms this package understands: whatever it says of a scope, it is not that.
			refusal, refused := errors.AsType[*Refusal](terms.Check("personal/age", testOffer(t, nil)))
			if refused {
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
			refusal: Refusal{Reason: ReasonCannotHonor, Condition: "custody"},
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

	// The agent is told the condition; the operator's log can also say which value was at fault.
	err = terms.Check("a", testOffer(t, nil))
	require.ErrorIs(t, err, spal.ErrInvalid)
	require.ErrorContains(t, err, "the rule for a")
	require.ErrorContains(t, err, "custody is 'my_laptop'")

	_, err = Parse([]byte(`{"version":"1.1"}`))
	require.ErrorContains(t, err, "terms_malformed: rules is missing")
}

// testOffer returns the conditions of a federated operator that keeps nothing and derives nothing, after change.
func testOffer(t *testing.T, change func(c *spal.Conditions)) spal.Conditions {
	t.Helper()

	conditions := spal.Conditions{
		Custody:          spal.CustodyFederatedOperator,
		RetentionSeconds: 0,
		Training:         spal.TrainingForbidden,
		Aggregation:      spal.AggregationForbidden,
		Resale:           spal.ResaleForbidden,
	}
	if change != nil {
		change(&conditions)
	}

	return conditions
}

// testRequireRefusal fails the test unless err is the refusal want, or nil where want is nil.
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

// testRules returns terms with one rule, for the scope "a", holding conditions.
func testRules(t *testing.T, conditions string) string {
	t.Helper()

	return `{"version":"1.1","rules":[{"context_scope":"a","conditions":` + conditions + `}]}`
}
