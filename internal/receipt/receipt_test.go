package receipt

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json/v2"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/spec/schemas"
)

const (
	// testDID is the did:key identifier of the key testSeedHex makes.
	testDID = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw"

	// testSeedHex is the seed of the first test key of RFC 8032, section 7.1.
	testSeedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
)

func TestSign(t *testing.T) {
	t.Parallel()

	key := testKey(t)
	statement := testStatement(t)

	got, err := Sign(key, statement)
	require.NoError(t, err)

	require.Equal(t, Receipt{
		OperatorDID:      testDID,
		TermsHash:        strings.Repeat("aa", 32),
		Nonce:            strings.Repeat("cc", 16),
		Commitment:       strings.Repeat("bb", 32),
		RequestID:        "req-7f3e2a1c",
		ServedAt:         1753000000,
		Custody:          spal.CustodyFederatedOperator,
		RetentionSeconds: 0,
		Training:         spal.TrainingForbidden,
		Aggregation:      spal.AggregationForbidden,
		Resale:           spal.ResaleForbidden,
		Signature:        "MECTBSD2keJRR3bMsJ9IoWBRVz5c8xyjwNw0bqGllh9DjAQCkAbI8LrdCPjDBjbwqhFwLI/pz6hIR74giV1SAQ==",
	}, got)

	// The signature is the operator's over the canonical bytes, for the key its identifier carries.
	public, err := didkey.PublicKey(got.OperatorDID)
	require.NoError(t, err)
	signature, err := base64.StdEncoding.DecodeString(got.Signature)
	require.NoError(t, err)
	signed, err := signedBytes(got.OperatorDID, got.ServedAt, statement)
	require.NoError(t, err)
	require.True(t, ed25519.Verify(public, signed, signature))
}

func TestSign_AcceptsTheEdges(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		change func(s *Statement)
	}{
		"no handle": {change: func(s *Statement) { s.RequestID = "" }},
		"a handle of the full length": {
			change: func(s *Statement) { s.RequestID = strings.Repeat("r", RequestIDMaxBytes) },
		},
		"a handle outside ASCII":       {change: func(s *Statement) { s.RequestID = "demande-é-7" }},
		"served at the epoch":          {change: func(s *Statement) { s.ServedAt = time.Unix(0, 0) }},
		"served at the last safe time": {change: func(s *Statement) { s.ServedAt = time.Unix(spal.MaxSafeInteger, 0) }},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			statement := testStatement(t)
			tc.change(&statement)

			_, err := Sign(testKey(t), statement)
			require.NoError(t, err)
		})
	}
}

func TestSign_Refused(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		change  func(s *Statement)
		key     ed25519.PrivateKey
		wantErr error
		wantMsg string
	}{
		"a key whose public half is not its seed's": {
			key: func() ed25519.PrivateKey {
				key := testKey(t)
				key[ed25519.PrivateKeySize-1] ^= 1
				return key
			}(),
			wantErr: ErrKey,
			wantMsg: "public half does not belong to its seed",
		},
		"a key of the wrong length": {
			key:     make(ed25519.PrivateKey, ed25519.SeedSize),
			wantErr: ErrKey,
			wantMsg: "a key is 64 bytes, got 32",
		},
		"conditions outside S-PAL": {
			change:  func(s *Statement) { s.Conditions.Training = "sometimes" },
			wantErr: spal.ErrInvalid,
			wantMsg: "training is 'sometimes'",
		},
		"conditions left unset": {
			change:  func(s *Statement) { s.Conditions = spal.Conditions{} },
			wantErr: ErrStatement,
			wantMsg: "custody is not set",
		},
		"retention above the safe range": {
			change:  func(s *Statement) { s.Conditions.RetentionSeconds = spal.MaxSafeInteger + 1 },
			wantErr: ErrStatement,
			wantMsg: "retention_seconds",
		},
		"a handle one byte too long": {
			change:  func(s *Statement) { s.RequestID = strings.Repeat("r", RequestIDMaxBytes+1) },
			wantErr: ErrStatement,
			wantMsg: "request_id is longer than 128 bytes",
		},
		"a handle too long in bytes, not in characters": {
			change:  func(s *Statement) { s.RequestID = strings.Repeat("é", RequestIDMaxBytes/2+1) },
			wantErr: ErrStatement,
			wantMsg: "request_id is longer than 128 bytes",
		},
		"a handle that is not UTF-8": {
			change:  func(s *Statement) { s.RequestID = "req-\xff" },
			wantErr: ErrStatement,
			wantMsg: "request_id is not valid UTF-8",
		},
		"a handle with a line feed": {
			change:  func(s *Statement) { s.RequestID = "req\n1" },
			wantErr: ErrStatement,
			wantMsg: "request_id carries a control character",
		},
		"a handle with a zero-width space": {
			change:  func(s *Statement) { s.RequestID = "req\u200b1" },
			wantErr: ErrStatement,
			wantMsg: "request_id carries a control character",
		},
		"a handle with a line separator": {
			change:  func(s *Statement) { s.RequestID = "req\u20281" },
			wantErr: ErrStatement,
			wantMsg: "request_id carries a control character",
		},
		"a handle that begins with a byte-order mark": {
			change:  func(s *Statement) { s.RequestID = "\ufeffreq" },
			wantErr: ErrStatement,
			wantMsg: "request_id carries a control character",
		},
		"served before 1970": {
			change:  func(s *Statement) { s.ServedAt = time.Unix(-1, 0) },
			wantErr: ErrStatement,
			wantMsg: "served_at is outside the range",
		},
		"served beyond the safe range": {
			change:  func(s *Statement) { s.ServedAt = time.Unix(spal.MaxSafeInteger+1, 0) },
			wantErr: ErrStatement,
			wantMsg: "served_at is outside the range",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			key := tc.key
			if key == nil {
				key = testKey(t)
			}
			statement := testStatement(t)
			if tc.change != nil {
				tc.change(&statement)
			}

			got, err := Sign(key, statement)
			require.ErrorIs(t, err, tc.wantErr)
			require.ErrorContains(t, err, tc.wantMsg)
			require.Empty(t, got)
		})
	}
}

func TestSign_ServedAtIsCarriedToTheSecond(t *testing.T) {
	t.Parallel()

	statement := testStatement(t)
	statement.ServedAt = time.Unix(1753000000, 999_999_999)

	got, err := Sign(testKey(t), statement)
	require.NoError(t, err)
	require.Equal(t, uint64(1753000000), got.ServedAt)
}

func TestSign_TravelsAsTheSpecifiedObject(t *testing.T) {
	t.Parallel()

	receipt, err := Sign(testKey(t), testStatement(t))
	require.NoError(t, err)

	data, err := json.Marshal(receipt)
	require.NoError(t, err)

	var members map[string]any
	require.NoError(t, json.Unmarshal(data, &members))

	want := []string{
		"operator_did", "terms_hash", "nonce", "commitment", "request_id", "served_at",
		"custody", "retention_seconds", "training", "aggregation", "resale", "signature",
	}
	require.Len(t, members, len(want))
	for _, member := range want {
		require.Contains(t, members, member)
	}
	require.InDelta(t, 1753000000, members["served_at"], 0)
	require.Equal(t, "federated_operator", members["custody"])
}

func TestSignedBytes_SpecVectors(t *testing.T) {
	t.Parallel()

	var file struct {
		Vectors []struct {
			EncodingHex string `json:"encoding_hex"`
			Fields      []struct {
				Name      string `json:"name"`
				ValueHex  string `json:"value_hex"`
				ValueUTF8 string `json:"value_utf8"`
			} `json:"fields"`
			Name      string `json:"name"`
			Structure string `json:"structure"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(schemas.EncodingVectors(), &file))

	ran := 0
	for _, tc := range file.Vectors {
		if tc.Structure != "terms_receipt" {
			continue
		}
		ran++

		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			text := map[string]string{}
			raw := map[string][]byte{}
			for _, field := range tc.Fields {
				text[field.Name] = field.ValueUTF8
				decoded, err := hex.DecodeString(field.ValueHex)
				require.NoError(t, err)
				raw[field.Name] = decoded
			}
			require.Equal(t, domainSeparator, text["domain_sep"])

			statement := Statement{
				RequestID: text["request_id"],
				Conditions: spal.Conditions{
					Custody:          spal.Custody(text["custody"]),
					RetentionSeconds: binary.BigEndian.Uint64(raw["retention_seconds"]),
					Training:         spal.Training(text["training"]),
					Aggregation:      spal.Aggregation(text["aggregation"]),
					Resale:           spal.Resale(text["resale"]),
				},
			}
			require.Equal(t, len(statement.TermsHash), copy(statement.TermsHash[:], raw["terms_hash"]))
			require.Equal(t, len(statement.Nonce), copy(statement.Nonce[:], raw["nonce"]))
			require.Equal(t, len(statement.Commitment), copy(statement.Commitment[:], raw["commitment"]))
			require.NoError(t, statement.Conditions.Validate())

			got, err := signedBytes(text["operator_did"], binary.BigEndian.Uint64(raw["served_at"]), statement)
			require.NoError(t, err)
			require.Equal(t, tc.EncodingHex, hex.EncodeToString(got))
		})
	}
	require.Equal(t, 2, ran, "the specification's two receipt vectors were not both found")
}

// testKey returns the first test key of RFC 8032, section 7.1.
func testKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()

	seed, err := hex.DecodeString(testSeedHex)
	require.NoError(t, err)

	return ed25519.NewKeyFromSeed(seed)
}

// testStatement returns the statement of the specification's receipt-served vector.
func testStatement(t *testing.T) Statement {
	t.Helper()

	statement := Statement{
		RequestID: "req-7f3e2a1c",
		ServedAt:  time.Unix(1753000000, 0),
		Conditions: spal.Conditions{
			Custody:          spal.CustodyFederatedOperator,
			RetentionSeconds: 0,
			Training:         spal.TrainingForbidden,
			Aggregation:      spal.AggregationForbidden,
			Resale:           spal.ResaleForbidden,
		},
	}
	copy(statement.TermsHash[:], bytes.Repeat([]byte{0xaa}, len(statement.TermsHash)))
	copy(statement.Nonce[:], bytes.Repeat([]byte{0xcc}, len(statement.Nonce)))
	copy(statement.Commitment[:], bytes.Repeat([]byte{0xbb}, len(statement.Commitment)))

	return statement
}
