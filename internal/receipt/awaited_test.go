package receipt

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
	"github.com/freehold-earth/freehold/spec/schemas"
)

const (
	// testRequest is the bytes of the request the tests send.
	testRequest = `{"method":"tools/call","params":{"name":"echo"}}`

	// testScope is a scope that testTerms governs.
	testScope = "notes"

	// testTerms is terms with one rule, which governs testScope.
	// The rule permits a federated operator, one hour of retention, training, and anonymized aggregation.
	// It has no resale condition.
	testTerms = `{"version":"1.1","rules":[{"context_scope":"notes","conditions":{
		"custody":{"operator":"federated_operator"},
		"retention":{"max_seconds":3600},
		"derivatives":{"training":"allowed","aggregation":"anonymized_only"}}}]}`
)

func TestAccept(t *testing.T) {
	awaited := testAwait(t, nil)
	presented, want := testReceipt(t, awaited, nil)

	got, err := awaited.Accept(presented)
	require.NoError(t, err)
	require.Equal(t, want, got)
}

func TestAccept_AnswersOnce(t *testing.T) {
	tests := map[string]struct {
		first      func(valid []byte) []byte
		wantReason Reason
	}{
		"after a receipt that was accepted": {first: func(valid []byte) []byte { return valid }},
		"after a response with no receipt": {
			first:      func([]byte) []byte { return nil },
			wantReason: ReasonMissing,
		},
		"after something that was no receipt": {
			first:      func([]byte) []byte { return []byte(`{}`) },
			wantReason: ReasonMalformed,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			awaited := testAwait(t, nil)
			valid, _ := testReceipt(t, awaited, nil)
			_, err := awaited.Accept(tc.first(valid))
			if tc.wantReason == "" {
				require.NoError(t, err)
			} else {
				testRequireRefusal(t, tc.wantReason, err)
			}

			// The first call used the Awaited, so the valid receipt is refused.
			got, err := awaited.Accept(valid)
			testRequireRefusal(t, ReasonSpent, err)
			require.Empty(t, got)
		})
	}
}

func TestAccept_AnswersOnceWhenPresentedTogether(t *testing.T) {
	awaited := testAwait(t, nil)
	valid, _ := testReceipt(t, awaited, nil)

	var accepted atomic.Int32
	var group sync.WaitGroup
	for range 16 {
		group.Go(func() {
			if _, err := awaited.Accept(valid); err == nil {
				accepted.Add(1)
			}
		})
	}
	group.Wait()

	require.Equal(t, int32(1), accepted.Load())
}

func TestAccept_Malformed(t *testing.T) {
	// Each constant is a member of the valid receipt as serialized, which a case replaces.
	const (
		custody   = `"custody":"federated_operator"`
		operator  = `"operator_did":"` + testDID + `"`
		requestID = `"request_id":"req-1"`
		retention = `"retention_seconds":0`
		servedAt  = `"served_at":1753000001`
		training  = `"training":"forbidden"`
	)

	tests := map[string]struct {
		new     string
		old     string
		wantMsg string
		whole   string
	}{
		"a custody level S-PAL does not have": {
			new:     `"custody":"my_laptop"`,
			old:     custody,
			wantMsg: "custody is not a value S-PAL allows for it",
		},
		"a custody level spelled another way": {
			new:     `"custody":"Federated_Operator"`,
			old:     custody,
			wantMsg: "custody is not a value S-PAL allows for it",
		},
		"a custody level that is not text": {new: `"custody":3`, old: custody, wantMsg: "custody is not text"},
		"a handle one byte too long": {
			new:     strings.Repeat("r", RequestIDMaxBytes+1),
			old:     `req-1`,
			wantMsg: "request_id is longer than 128 bytes",
		},
		"a handle with a line feed": {
			new:     `req\n1`,
			old:     `req-1`,
			wantMsg: "request_id carries a control character",
		},
		"a handle with a line separator": {
			new:     `req\u20281`,
			old:     `req-1`,
			wantMsg: "request_id carries a control character",
		},
		"a handle with a zero-width space": {
			new:     `req\u200b1`,
			old:     `req-1`,
			wantMsg: "request_id carries a control character",
		},
		"a member a receipt does not have": {
			new:     `{"note":"kept",`,
			old:     `{`,
			wantMsg: "a member a receipt does not have",
		},
		"a member left out": {new: ``, old: requestID + `,`, wantMsg: "request_id is missing"},
		"a member named in another case": {
			new:     `"Custody"`,
			old:     `"custody"`,
			wantMsg: "custody is missing",
		},
		"a member named twice": {
			new:     requestID + `,` + requestID,
			old:     requestID,
			wantMsg: "not well-formed JSON",
		},
		"a member that is null": {new: `"request_id":null`, old: requestID, wantMsg: "request_id is not text"},
		"a resale value that belongs to aggregation": {
			new:     `"resale":"anonymized_only"`,
			old:     `"resale":"forbidden"`,
			wantMsg: "resale is not a value S-PAL allows for it",
		},
		"a served time above the safe range": {
			new:     `"served_at":9007199254740992`,
			old:     servedAt,
			wantMsg: "served_at is not a whole number",
		},
		"a served time below zero": {
			new:     `"served_at":-1`,
			old:     servedAt,
			wantMsg: "served_at is not a whole number",
		},
		"a served time of minus zero": {
			new:     `"served_at":-0`,
			old:     servedAt,
			wantMsg: "served_at is not a whole number",
		},
		"a served time that is null": {
			new:     `"served_at":null`,
			old:     servedAt,
			wantMsg: "served_at is not a whole number",
		},
		"a served time with a fraction": {
			new:     `"served_at":1753000001.0`,
			old:     servedAt,
			wantMsg: "served_at is not a whole number",
		},
		"a served time with an exponent": {
			new:     `"served_at":1753000001e0`,
			old:     servedAt,
			wantMsg: "served_at is not a whole number",
		},
		"a served time written as text": {
			new:     `"served_at":"1753000001"`,
			old:     servedAt,
			wantMsg: "served_at is not a whole number",
		},
		"a training value that belongs to resale": {
			new:     `"training":"requires_consent"`,
			old:     training,
			wantMsg: "training is not a value S-PAL allows for it",
		},
		"an aggregation value that belongs to training": {
			new:     `"aggregation":"requires_payment"`,
			old:     `"aggregation":"forbidden"`,
			wantMsg: "aggregation is not a value S-PAL allows for it",
		},
		"an array":                     {whole: `[]`, wantMsg: "not a JSON object"},
		"an object cut short":          {whole: `{"operator_did":`, wantMsg: "not well-formed JSON"},
		"an operator that is not text": {new: `"operator_did":7`, old: operator, wantMsg: "operator_did is not text"},
		"no members":                   {whole: `{}`, wantMsg: "operator_did is missing"},
		"null":                         {whole: `null`, wantMsg: "not a JSON object"},
		"only space":                   {whole: ` `, wantMsg: "not a JSON object"},
		"retention above the safe range": {
			new:     `"retention_seconds":9007199254740992`,
			old:     retention,
			wantMsg: "retention_seconds is not a whole number",
		},
		"retention with a fraction": {
			new:     `"retention_seconds":0.5`,
			old:     retention,
			wantMsg: "retention_seconds is not a whole number",
		},
		"text":                   {whole: `"receipt"`, wantMsg: "not a JSON object"},
		"text that is not UTF-8": {new: "req-\xff", old: `req-1`, wantMsg: "not well-formed JSON"},
		"two objects":            {new: `}{}`, old: `}`, wantMsg: "not well-formed JSON"},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			awaited := testAwait(t, nil)
			// A malformed receipt fails before the served-time check, so a fixed served time is safe here.
			valid, _ := testReceipt(t, awaited, func(s *Statement) { s.ServedAt = time.Unix(1753000001, 0) })

			presented := tc.whole
			if presented == "" {
				require.Contains(t, string(valid), tc.old)
				presented = strings.Replace(string(valid), tc.old, tc.new, 1)
			}

			got, err := awaited.Accept([]byte(presented))
			testRequireRefusal(t, ReasonMalformed, err)
			require.ErrorContains(t, err, tc.wantMsg)
			require.Empty(t, got)
		})
	}
}

func TestAccept_MalformedHex(t *testing.T) {
	tests := map[string]struct {
		change  func(r *Receipt)
		wantMsg string
	}{
		"a commitment as short as a nonce": {
			change:  func(r *Receipt) { r.Commitment = r.Commitment[:32] },
			wantMsg: "commitment is not 64 lowercase hex characters",
		},
		"a hash in upper case": {
			change:  func(r *Receipt) { r.TermsHash = strings.ToUpper(r.TermsHash) },
			wantMsg: "terms_hash is not 64 lowercase hex characters",
		},
		"a hash one byte long": {
			change:  func(r *Receipt) { r.TermsHash += "00" },
			wantMsg: "terms_hash is not 64 lowercase hex characters",
		},
		"a hash one character short": {
			change:  func(r *Receipt) { r.TermsHash = r.TermsHash[1:] },
			wantMsg: "terms_hash is not 64 lowercase hex characters",
		},
		"a hash that is empty": {
			change:  func(r *Receipt) { r.TermsHash = "" },
			wantMsg: "terms_hash is not 64 lowercase hex characters",
		},
		"a hash that is not hex": {
			change:  func(r *Receipt) { r.TermsHash = "zz" + r.TermsHash[2:] },
			wantMsg: "terms_hash is not 64 lowercase hex characters",
		},
		"a nonce as long as a hash": {
			change:  func(r *Receipt) { r.Nonce += r.Nonce },
			wantMsg: "nonce is not 32 lowercase hex characters",
		},
		"a nonce in upper case": {
			change:  func(r *Receipt) { r.Nonce = strings.ToUpper(r.Nonce) },
			wantMsg: "nonce is not 32 lowercase hex characters",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			awaited := testAwait(t, nil)
			// The nonce is all letters, so its upper-case form differs.
			_, receipt := testReceipt(t, awaited, func(s *Statement) { s.Nonce = [NonceSize]byte{0xab, 0xcd, 0xef} })
			receipt.TermsHash = strings.Repeat("ab", 32)
			tc.change(&receipt)
			presented, err := json.Marshal(receipt)
			require.NoError(t, err)

			got, err := awaited.Accept(presented)
			testRequireRefusal(t, ReasonMalformed, err)
			require.ErrorContains(t, err, tc.wantMsg)
			require.Empty(t, got)
		})
	}
}

func TestAccept_MalformedSignature(t *testing.T) {
	// These 64 bytes are not a valid signature.
	// Their base64 form is "+/+/" 21 times and then "AA==", where the last "A" has four unused bits.
	wellFormed := base64.StdEncoding.EncodeToString(append(bytes.Repeat([]byte{0xfb, 0xff, 0xbf}, 21), 0x00))
	require.True(t, strings.HasPrefix(wellFormed, "+/+/") && strings.HasSuffix(wellFormed, "+/AA=="))

	tests := map[string]struct {
		signature string
		want      Reason
	}{
		"broken across lines": {signature: wellFormed[:44] + "\n" + wellFormed[44:], want: ReasonMalformed},
		"empty":               {signature: "", want: ReasonMalformed},
		"in the URL alphabet": {
			signature: strings.NewReplacer("+", "-", "/", "_").Replace(wellFormed),
			want:      ReasonMalformed,
		},
		"not base64": {signature: "!!!", want: ReasonMalformed},
		"of a longer signature": {
			signature: base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize+1)),
			want:      ReasonMalformed,
		},
		"of a shorter signature": {
			signature: base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize-1)),
			want:      ReasonMalformed,
		},
		"with bits set that no byte holds": {
			signature: strings.TrimSuffix(wellFormed, "A==") + "B==",
			want:      ReasonMalformed,
		},
		"without padding": {signature: strings.TrimRight(wellFormed, "="), want: ReasonMalformed},
		// The canonical encoding parses, and then fails signature verification.
		"written as it should be": {signature: wellFormed, want: ReasonSignature},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			awaited := testAwait(t, nil)
			_, receipt := testReceipt(t, awaited, nil)
			receipt.Signature = tc.signature
			presented, err := json.Marshal(receipt)
			require.NoError(t, err)

			got, err := awaited.Accept(presented)
			testRequireRefusal(t, tc.want, err)
			if tc.want == ReasonMalformed {
				require.ErrorContains(t, err, "signature is not the canonical base64 of an Ed25519 signature")
			}
			require.Empty(t, got)
		})
	}
}

func TestAccept_NothingAwaited(t *testing.T) {
	valid, _ := testReceipt(t, testAwait(t, nil), nil)

	// The zero Awaited refuses every input.
	for _, presented := range [][]byte{valid, []byte(`{}`), nil} {
		got, err := new(Awaited).Accept(presented)
		testRequireRefusal(t, ReasonSpent, err)
		require.Empty(t, got)
	}
}

func TestAccept_NothingPresented(t *testing.T) {
	tests := map[string]struct {
		presented []byte
	}{
		"nil":      {presented: nil},
		"no bytes": {presented: []byte{}},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			got, err := testAwait(t, nil).Accept(tc.presented)
			testRequireRefusal(t, ReasonMissing, err)
			require.Empty(t, got)
		})
	}
}

func TestAccept_RefusalSaysNothingThePresenterChose(t *testing.T) {
	const marker = "CANARY"

	// Each value is the marker in one form that a member can hold.
	values := map[string]string{
		"after valid hex":   `"` + strings.Repeat("ab", 32) + marker + `"`,
		"as a custody word": `"` + strings.ToLower(marker) + `"`,
		"as a list":         `["` + marker + `"]`,
		"as an object":      `{"` + marker + `":"` + marker + `"}`,
		"as text":           `"` + marker + `"`,
		"on a second line":  `"req\n` + marker + `"`,
	}

	for _, member := range append([]string{marker}, members...) {
		for name, value := range values {
			t.Run(member+" "+name, func(t *testing.T) {
				awaited := testAwait(t, nil)
				valid, _ := testReceipt(t, awaited, nil)

				var object map[string]jsontext.Value
				require.NoError(t, json.Unmarshal(valid, &object))
				object[member] = jsontext.Value(value)
				presented, err := json.Marshal(object)
				require.NoError(t, err)

				got, err := awaited.Accept(presented)
				refusal, ok := errors.AsType[*Refusal](err)
				require.True(t, ok, "want a refusal, got %v", err)
				require.NotContains(t, strings.ToUpper(refusal.Error()), marker)
				require.Empty(t, got)
			})
		}
	}
}

func TestAccept_Refused(t *testing.T) {
	// other is the key of a second operator.
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))

	tests := map[string]struct {
		change     func(s *Statement)
		key        ed25519.PrivateKey
		new        string
		old        string
		wantMsg    string
		wantReason Reason
	}{
		"aggregation allowed, where the rule says anonymized only": {
			change:     func(s *Statement) { s.Conditions.Aggregation = spal.AggregationAllowed },
			wantMsg:    "aggregation is allowed, where the rule says anonymized_only",
			wantReason: ReasonConditions,
		},
		"altered after it was signed": {
			new:        `"retention_seconds":1`,
			old:        `"retention_seconds":0`,
			wantReason: ReasonSignature,
		},
		"another receipt's signature": {
			// The signature is valid, but it covers a receipt with a different request ID.
			old:        `"request_id":"req-1"`,
			new:        `"request_id":"req-2"`,
			wantReason: ReasonSignature,
		},
		"custody beyond the rule's ceiling": {
			change:     func(s *Statement) { s.Conditions.Custody = spal.CustodyAttestedEnclave },
			wantMsg:    "custody is attested_enclave, beyond the rule's federated_operator",
			wantReason: ReasonConditions,
		},
		"for another commitment": {
			change:     func(s *Statement) { s.Commitment[0] ^= 1 },
			wantReason: ReasonCommitment,
		},
		"for another nonce": {
			change:     func(s *Statement) { s.Nonce[NonceSize-1] ^= 1 },
			wantReason: ReasonNonce,
		},
		"for other terms": {
			change:     func(s *Statement) { s.TermsHash[0] ^= 1 },
			wantReason: ReasonTerms,
		},
		"resale with consent, where the rule says nothing": {
			change:     func(s *Statement) { s.Conditions.Resale = spal.ResaleRequiresConsent },
			wantMsg:    "resale is requires_consent, where the rule says forbidden",
			wantReason: ReasonConditions,
		},
		"retention a second longer than the rule allows": {
			change:     func(s *Statement) { s.Conditions.RetentionSeconds = 3601 },
			wantMsg:    "retention is 3601 seconds, above the rule's 3600",
			wantReason: ReasonConditions,
		},
		"served long after the response arrived": {
			change:     func(s *Statement) { s.ServedAt = time.Now().Add(time.Hour) },
			wantReason: ReasonServedAt,
		},
		"served long before the request was sent": {
			change:     func(s *Statement) { s.ServedAt = time.Now().Add(-time.Hour) },
			wantReason: ReasonServedAt,
		},
		"signed by another operator, as itself": {
			key:        other,
			wantReason: ReasonOperator,
		},
		"training for payment, where the rule says allowed": {
			// The tolerance order ranks this value as stricter.
			// A receipt must state the rule's value or forbidden.
			change:     func(s *Statement) { s.Conditions.Training = spal.TrainingRequiresPayment },
			wantReason: ReasonConditions,
			wantMsg:    "training is requires_payment, where the rule says allowed",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			awaited := testAwait(t, nil)

			statement := testStatementFor(t, awaited, tc.change)
			key := tc.key
			if key == nil {
				key = testKey(t)
			}
			receipt, err := Sign(key, statement)
			require.NoError(t, err)
			presented, err := json.Marshal(receipt)
			require.NoError(t, err)
			if tc.old != "" {
				require.Contains(t, string(presented), tc.old)
				presented = []byte(strings.Replace(string(presented), tc.old, tc.new, 1))
			}

			got, err := awaited.Accept(presented)
			testRequireRefusal(t, tc.wantReason, err)
			require.ErrorContains(t, err, tc.wantMsg)
			require.Empty(t, got)
		})
	}
}

func TestAccept_ServedAtWindow(t *testing.T) {
	// The request is labeled 0.9 seconds into a second, and the receipt is presented 0.1 seconds into the next.
	// Both ends of the window round outward to a whole second.
	// Each offset is in seconds from the second of labeling.
	tests := map[string]struct {
		servedAt int64
		want     Reason
	}{
		"the first second of the window":     {servedAt: -300},
		"the last second of the window":      {servedAt: 1 + 300 + 1},
		"the second after the window":        {servedAt: 1 + 300 + 2, want: ReasonServedAt},
		"the second before the window":       {servedAt: -301, want: ReasonServedAt},
		"the second the request was labeled": {servedAt: 0},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				// A synctest clock starts on a whole second and advances only when the test sleeps.
				labeled := time.Now().Unix()
				time.Sleep(900 * time.Millisecond)
				awaited := testAwait(t, nil)
				presented, _ := testReceipt(t, awaited, func(s *Statement) {
					s.ServedAt = time.Unix(labeled+tc.servedAt, 0)
				})
				time.Sleep(200 * time.Millisecond)

				_, err := awaited.Accept(presented)
				if tc.want == "" {
					require.NoError(t, err)
					return
				}
				testRequireRefusal(t, tc.want, err)
			})
		})
	}
}

func TestAccept_ServedAtWindowOnWholeSeconds(t *testing.T) {
	// The request is labeled and the receipt is presented on whole seconds, so neither end of the window rounds.
	// Each offset is in seconds from the second of labeling.
	tests := map[string]struct {
		servedAt int64
		want     Reason
	}{
		"the first second of the window": {servedAt: -300},
		"the last second of the window":  {servedAt: 2 + 300},
		"the second after the window":    {servedAt: 2 + 301, want: ReasonServedAt},
		"the second before the window":   {servedAt: -301, want: ReasonServedAt},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				// A synctest clock starts on a whole second and advances only when the test sleeps.
				labeled := time.Now().Unix()
				awaited := testAwait(t, nil)
				presented, _ := testReceipt(t, awaited, func(s *Statement) {
					s.ServedAt = time.Unix(labeled+tc.servedAt, 0)
				})
				time.Sleep(2 * time.Second)

				_, err := awaited.Accept(presented)
				if tc.want == "" {
					require.NoError(t, err)
					return
				}
				testRequireRefusal(t, tc.want, err)
			})
		})
	}
}

func TestAccept_SpecVectors(t *testing.T) {
	var file struct {
		Vectors []struct {
			Commitment *spal.Conditions `json:"commitment"`
			Name       string           `json:"name"`
			Overclaims []struct {
				Conditions spal.Conditions `json:"conditions"`
				Name       string          `json:"name"`
			} `json:"overclaims"`
			Scope string         `json:"context_scope"`
			Terms jsontext.Value `json:"terms"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(schemas.CommitmentVectors(), &file))

	served, overclaims := 0, 0
	for _, tc := range file.Vectors {
		if tc.Commitment == nil {
			continue
		}
		served++

		written, err := terms.Parse(tc.Terms)
		require.NoError(t, err)
		request := func(r *Request) { r.Terms, r.Scope = written, tc.Scope }

		t.Run(tc.Name, func(t *testing.T) {
			awaited := testAwait(t, request)
			presented, _ := testReceipt(t, awaited, func(s *Statement) { s.Conditions = *tc.Commitment })

			_, err := awaited.Accept(presented)
			require.NoError(t, err)
		})

		for _, overclaim := range tc.Overclaims {
			overclaims++

			t.Run(tc.Name+"/"+overclaim.Name, func(t *testing.T) {
				awaited := testAwait(t, request)
				presented, _ := testReceipt(t, awaited, func(s *Statement) { s.Conditions = overclaim.Conditions })

				_, err := awaited.Accept(presented)
				testRequireRefusal(t, ReasonConditions, err)
			})
		}
	}
	require.NotZero(t, served, "the specification's served vectors were not found")
	require.NotZero(t, overclaims, "the specification's overclaims were not found")
}

func TestAccept_WithinTheRule(t *testing.T) {
	tests := map[string]struct {
		change func(s *Statement)
	}{
		"custody at the rule's ceiling": {
			change: func(s *Statement) { s.Conditions.Custody = spal.CustodyFederatedOperator },
		},
		"custody nearer than the rule's ceiling": {
			change: func(s *Statement) { s.Conditions.Custody = spal.CustodyDeviceOnly },
		},
		"each derivative as the rule says": {
			change: func(s *Statement) {
				s.Conditions.Training = spal.TrainingAllowed
				s.Conditions.Aggregation = spal.AggregationAnonymizedOnly
			},
		},
		"no handle": {change: func(s *Statement) { s.RequestID = "" }},
		"retention as long as the rule allows": {
			change: func(s *Statement) { s.Conditions.RetentionSeconds = 3600 },
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			awaited := testAwait(t, nil)
			presented, want := testReceipt(t, awaited, tc.change)

			got, err := awaited.Accept(presented)
			require.NoError(t, err)
			require.Equal(t, want, got)
		})
	}
}

func TestAwait(t *testing.T) {
	first := testAwait(t, nil)
	second := testAwait(t, nil)

	// Two requests with the same bytes get different nonces, and so different commitments.
	require.NotEqual(t, first.Label().Nonce, second.Label().Nonce)
	require.NotEqual(t, first.Label().Commitment, second.Label().Commitment)

	written, err := terms.Parse([]byte(testTerms))
	require.NoError(t, err)

	for _, awaited := range []*Awaited{first, second} {
		label := awaited.Label()
		require.Equal(t, written.Hash(), label.TermsHash)
		require.NotZero(t, label.Nonce)
		require.Equal(t, commitment(testAuditKey(t), testDID, label.Nonce, []byte(testRequest)), label.Commitment)
	}
}

func TestAwait_Refused(t *testing.T) {
	tests := map[string]struct {
		auditKey   []byte
		change     func(r *Request)
		wantErr    error
		wantReason terms.Reason
	}{
		"a scope the terms do not govern": {
			change:     func(r *Request) { r.Scope = "health" },
			wantReason: terms.ReasonScopeNotGoverned,
		},
		"an audit key one byte short": {
			auditKey: make([]byte, AuditKeyMinBytes-1),
			wantErr:  ErrAuditKey,
		},
		"an operator that signs as a web domain": {
			change:  func(r *Request) { r.Operator = "did:web:operator.example" },
			wantErr: didkey.ErrNotEd25519,
		},
		"no audit key": {
			auditKey: []byte{},
			wantErr:  ErrAuditKey,
		},
		"no operator": {
			change:  func(r *Request) { r.Operator = "" },
			wantErr: didkey.ErrNotEd25519,
		},
		"no terms": {
			change:  func(r *Request) { r.Terms = nil },
			wantErr: ErrTerms,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			written, err := terms.Parse([]byte(testTerms))
			require.NoError(t, err)
			request := Request{
				Bytes:    []byte(testRequest),
				Operator: testDID,
				Scope:    testScope,
				Terms:    written,
			}
			if tc.change != nil {
				tc.change(&request)
			}
			auditKey := tc.auditKey
			if auditKey == nil {
				auditKey = testAuditKey(t)
			}

			got, err := Await(auditKey, request)
			require.Nil(t, got)
			if tc.wantErr != nil {
				require.ErrorIs(t, err, tc.wantErr)
				return
			}
			refusal, ok := errors.AsType[*terms.Refusal](err)
			require.True(t, ok, "want a terms refusal, got %v", err)
			require.Equal(t, tc.wantReason, refusal.Reason)
		})
	}
}

func TestCommitment_MatchesTheAgent(t *testing.T) {
	// The Python agent computes these values for the same inputs.
	const (
		operator       = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
		wantCommitment = "6d968dcce97063f1019fd8e895e7bf413dcdcd0cc669fcbdc9cf92d86165a63f"
		wantRequestKey = "6449107c55f3572b7ac007853efb6e1cf39d649c0e427fbac4cf85d2e1d22c4a"
	)
	nonce := [NonceSize]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}

	require.Equal(t, wantRequestKey, hex.EncodeToString(requestKey(testAuditKey(t), operator, nonce)))

	got := commitment(testAuditKey(t), operator, nonce, []byte(testRequest))
	require.Equal(t, wantCommitment, hex.EncodeToString(got[:]))
}

func TestRefusal_Error(t *testing.T) {
	tests := map[string]struct {
		refusal *Refusal
		want    string
	}{
		"a reason that says it all": {
			refusal: &Refusal{Reason: ReasonSpent},
			want:    "receipt refused: spent",
		},
		"a reason with what was found": {
			refusal: &Refusal{Reason: ReasonMalformed, cause: errors.New("nonce is missing")},
			want:    "receipt refused: malformed: nonce is missing",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			require.EqualError(t, tc.refusal, tc.want)
			require.Equal(t, tc.refusal.cause, errors.Unwrap(tc.refusal))
		})
	}
}

// testAuditKey returns the bytes 0 to 31 as an audit key.
func testAuditKey(t *testing.T) []byte {
	t.Helper()

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}

	return key
}

// testAwait returns the Awaited for testRequest under testTerms, with change applied to the request.
func testAwait(t *testing.T, change func(r *Request)) *Awaited {
	t.Helper()

	written, err := terms.Parse([]byte(testTerms))
	require.NoError(t, err)
	request := Request{
		Bytes:    []byte(testRequest),
		Operator: testDID,
		Scope:    testScope,
		Terms:    written,
	}
	if change != nil {
		change(&request)
	}

	awaited, err := Await(testAuditKey(t), request)
	require.NoError(t, err)

	return awaited
}

// testReceipt signs the statement from testStatementFor with testKey.
// It returns the receipt as JSON and as a Receipt.
func testReceipt(t *testing.T, awaited *Awaited, change func(s *Statement)) ([]byte, Receipt) {
	t.Helper()

	receipt, err := Sign(testKey(t), testStatementFor(t, awaited, change))
	require.NoError(t, err)
	presented, err := json.Marshal(receipt)
	require.NoError(t, err)

	return presented, receipt
}

// testRequireRefusal fails the test unless err is a *Refusal with the reason want.
func testRequireRefusal(t *testing.T, want Reason, err error) {
	t.Helper()

	got, ok := errors.AsType[*Refusal](err)
	require.True(t, ok, "want a refusal, got %v", err)
	require.Equal(t, want, got.Reason)
}

// testStatementFor returns a valid statement for awaited with the strictest conditions, with change applied.
func testStatementFor(t *testing.T, awaited *Awaited, change func(s *Statement)) Statement {
	t.Helper()

	statement := Statement{
		Commitment: awaited.Label().Commitment,
		Conditions: spal.Conditions{
			Custody:     spal.CustodyFederatedOperator,
			Training:    spal.TrainingForbidden,
			Aggregation: spal.AggregationForbidden,
			Resale:      spal.ResaleForbidden,
		},
		Nonce:     awaited.Label().Nonce,
		RequestID: "req-1",
		ServedAt:  time.Now(),
		TermsHash: awaited.Label().TermsHash,
	}
	if change != nil {
		change(&statement)
	}

	return statement
}
