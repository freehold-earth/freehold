package audit

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/receipt"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

func TestLog_Close(t *testing.T) {
	log, err := Open(filepath.Join(t.TempDir(), "audit.jsonl"))
	require.NoError(t, err)
	require.NoError(t, log.Close())

	require.ErrorIs(t, log.Record(Entry{Outcome: OutcomeRefused}), os.ErrClosed)
	require.ErrorIs(t, log.Close(), os.ErrClosed)
}

func TestLog_Record(t *testing.T) {
	at := time.Date(2026, time.November, 17, 9, 30, 0, 0, time.UTC)
	conditions := spal.Conditions{
		Custody:          spal.CustodyFederatedOperator,
		RetentionSeconds: 3600,
		Training:         spal.TrainingForbidden,
		Aggregation:      spal.AggregationAnonymizedOnly,
		Resale:           spal.ResaleForbidden,
	}

	tests := map[string]struct {
		entry Entry
		want  string
	}{
		"an accepted request, with what the operator committed to": {
			entry: Entry{
				Time:         at,
				Outcome:      OutcomeAccepted,
				Method:       "tools/call",
				RequestID:    "req-1",
				TermsHash:    "ab",
				Nonce:        "cd",
				ContextScope: "notes/2026",
				Conditions:   &conditions,
			},
			want: `{"time":"2026-11-17T09:30:00Z","outcome":"accepted","method":"tools/call","request_id":"req-1",` +
				`"terms_hash":"ab","nonce":"cd","context_scope":"notes/2026","conditions":{"custody":` +
				`"federated_operator","retention_seconds":3600,"training":"forbidden","aggregation":` +
				`"anonymized_only","resale":"forbidden"}}`,
		},
		"a served request, with the receipt": {
			entry: Entry{
				Time:      at,
				Outcome:   OutcomeServed,
				Method:    "tools/call",
				RequestID: "req-1",
				Receipt:   &receipt.Receipt{OperatorDID: "did:key:z6Mk", RequestID: "req-1", Signature: "c2ln"},
			},
			want: `{"time":"2026-11-17T09:30:00Z","outcome":"served","method":"tools/call","request_id":"req-1",` +
				`"receipt":{"operator_did":"did:key:z6Mk","terms_hash":"","nonce":"","commitment":"",` +
				`"request_id":"req-1","served_at":0,"custody":"","retention_seconds":0,"training":"",` +
				`"aggregation":"","resale":"","signature":"c2ln"}}`,
		},
		"a refusal that names a condition": {
			entry: Entry{
				Time:      at,
				Outcome:   OutcomeRefused,
				Method:    "resources/read",
				TermsHash: "ab",
				Nonce:     "cd",
				Reason:    terms.ReasonCannotHonor,
				Condition: "custody",
			},
			want: `{"time":"2026-11-17T09:30:00Z","outcome":"refused","method":"resources/read","terms_hash":"ab",` +
				`"nonce":"cd","reason":"cannot_honour","condition":"custody"}`,
		},
		"a refusal with nothing to name": {
			entry: Entry{Time: at, Outcome: OutcomeRefused, Method: "tools/call", Reason: terms.ReasonTermsRequired},
			want:  `{"time":"2026-11-17T09:30:00Z","outcome":"refused","method":"tools/call","reason":"terms_required"}`,
		},
		"text from a request cannot start a line of its own": {
			entry: Entry{Time: at, Outcome: OutcomeRefused, Method: "tools/call\n{\"outcome\":\"served\"}"},
			want:  `{"time":"2026-11-17T09:30:00Z","outcome":"refused","method":"tools/call\n{\"outcome\":\"served\"}"}`,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "audit.jsonl")
			log, err := Open(path)
			require.NoError(t, err)
			require.NoError(t, log.Record(tc.entry))
			require.NoError(t, log.Close())

			written, err := os.ReadFile(path)
			require.NoError(t, err)
			require.Equal(t, tc.want+"\n", string(written))
		})
	}
}

func TestLog_RecordAtOnce(t *testing.T) {
	const lines = 50
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	log, err := Open(path)
	require.NoError(t, err)

	errs := make([]error, lines)
	var wg sync.WaitGroup
	for i := range lines {
		wg.Go(func() {
			errs[i] = log.Record(Entry{Outcome: OutcomeRefused, Method: "tools/call"})
		})
	}
	wg.Wait()
	require.NoError(t, errors.Join(errs...))
	require.NoError(t, log.Close())

	written, err := os.ReadFile(path)
	require.NoError(t, err)
	want := strings.Repeat(`{"time":"0001-01-01T00:00:00Z","outcome":"refused","method":"tools/call"}`+"\n", lines)
	require.Equal(t, want, string(written))
}

func TestOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")

	log, err := Open(path)
	require.NoError(t, err)
	require.NoError(t, log.Record(Entry{Outcome: OutcomeRefused, Method: "first"}))
	require.NoError(t, log.Close())

	info, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, ownerOnly, info.Mode().Perm())

	again, err := Open(path)
	require.NoError(t, err)
	require.NoError(t, again.Record(Entry{Outcome: OutcomeRefused, Method: "second"}))
	require.NoError(t, again.Close())

	written, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t,
		`{"time":"0001-01-01T00:00:00Z","outcome":"refused","method":"first"}`+"\n"+
			`{"time":"0001-01-01T00:00:00Z","outcome":"refused","method":"second"}`+"\n",
		string(written))
}

func TestOpen_NoSuchDirectory(t *testing.T) {
	_, err := Open(filepath.Join(t.TempDir(), "missing", "audit.jsonl"))
	require.ErrorIs(t, err, os.ErrNotExist)
}
