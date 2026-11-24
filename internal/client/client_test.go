package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/audit"
	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/proxy"
	"github.com/freehold-earth/freehold/internal/receipt"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

// testTerms holds three rules.
// The rule for notes lets data go to a federated operator and be kept for one hour.
// The rule for home states no custody level, and the rule for sealed requires attestation.
const testTerms = `{"version":"1.1","rules":[` +
	`{"context_scope":"notes","conditions":` +
	`{"custody":{"operator":"federated_operator"},"retention":{"max_seconds":3600}}},` +
	`{"context_scope":"home","conditions":{}},` +
	`{"context_scope":"sealed","conditions":` +
	`{"custody":{"operator":"federated_operator","attestation_required":true}}}]}`

// testAuditKey is the end-user's audit key in tests.
var testAuditKey = bytes.Repeat([]byte{7}, receipt.AuditKeyMinBytes)

// testKey is the operator's signing key in tests.
var testKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))

// testEchoInput is the input of the test server's tool.
type testEchoInput struct {
	// Text is the text the tool returns.
	Text string `json:"text"`
}

// testOperator is an operator's proxy in front of an MCP server, with a record of what an end-user sent to it.
type testOperator struct {
	// alter changes the body of a response to method before the end-user receives it.
	// A nil alter changes nothing.
	alter func(method string, body []byte) []byte

	// calls holds the tool calls received, in order.
	calls []testWire

	// did is the operator's DID.
	did string

	// mu guards calls.
	mu sync.Mutex

	// url is the address the end-user connects to.
	url string
}

// testOutcome is the outcome of one request, as an end-user's record stores it.
type testOutcome struct {
	// label is the label the request was sent under.
	label receipt.Label

	// outcome is how the request ended.
	outcome Outcome
}

// testRecord is an end-user's record that fails with err when err is set.
type testRecord struct {
	// after is the number of entries the record stores before it fails.
	after int

	// before holds, for each entry, the number of tool calls the operator had received when it was recorded.
	before []int

	// err is the error Record returns, or nil.
	err error

	// operator is the operator the requests go to.
	operator *testOperator

	// outcomeErr is the error RecordOutcome returns, or nil.
	outcomeErr error

	// outcomes holds the outcomes recorded, in order.
	outcomes []testOutcome

	// sent holds the entries recorded, in order.
	sent []Sent
}

// testTransport is an http.RoundTripper made from a function.
type testTransport func(r *http.Request) (*http.Response, error)

// testWire is a tool call as the operator received it.
type testWire struct {
	// Method is the method of the request.
	Method string `json:"method"`

	// Params is the parameters of the request.
	Params jsontext.Value `json:"params"`
}

// Record adds sent to the record, or returns the error the record is set to fail with.
func (r *testRecord) Record(sent Sent) error {
	if r.err != nil && len(r.sent) >= r.after {
		return r.err
	}
	r.before = append(r.before, len(r.operator.received()))
	r.sent = append(r.sent, sent)

	return nil
}

// RoundTrip makes the request with the function.
func (f testTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

// RecordOutcome adds the outcome to the record, or returns the error the record is set to fail with.
func (r *testRecord) RecordOutcome(label receipt.Label, outcome Outcome) error {
	if r.outcomeErr != nil {
		return r.outcomeErr
	}
	r.outcomes = append(r.outcomes, testOutcome{label: label, outcome: outcome})

	return nil
}

// ended returns the outcomes recorded, in order, and requires that each has the label of the request it follows.
func (r *testRecord) ended(t *testing.T) []Outcome {
	t.Helper()

	require.Len(t, r.outcomes, len(r.sent))
	ended := make([]Outcome, len(r.outcomes))
	for i, entry := range r.outcomes {
		require.Equal(t, r.sent[i].Label, entry.label)
		ended[i] = entry.outcome
	}

	return ended
}

// received returns the tool calls the operator has received.
func (o *testOperator) received() []testWire {
	o.mu.Lock()
	defer o.mu.Unlock()

	return append([]testWire(nil), o.calls...)
}

// serve records a tool call, passes the request to the proxy and returns the proxy's response.
func (o *testOperator) serve(p *proxy.Proxy, w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var wire testWire
	if len(body) > 0 && json.Unmarshal(body, &wire) == nil && wire.Method == methodCallTool {
		o.mu.Lock()
		o.calls = append(o.calls, wire)
		o.mu.Unlock()
	}

	inner := r.Clone(r.Context())
	inner.Body = io.NopCloser(bytes.NewReader(body))
	answer := httptest.NewRecorder()
	p.ServeHTTP(answer, inner)

	answered := answer.Body.Bytes()
	if o.alter != nil && wire.Method != "" {
		answered = o.alter(wire.Method, answered)
	}
	for name, values := range answer.Header() {
		if name != "Content-Length" {
			w.Header()[name] = values
		}
	}
	w.WriteHeader(answer.Code)
	_, _ = w.Write(answered)
}

func TestConnect_AServerOnAnOlderProtocol(t *testing.T) {
	operator := testServe(t)
	advertised := `{"operator_did":"` + operator.did + `","custody":"federated_operator","retention_min_seconds":0,` +
		`"training":"forbidden","aggregation":"forbidden","resale":"forbidden","terms":"optional"}`

	// The server knows no discovery and answers the older handshake with the advertisement.
	older := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var message struct {
			ID     jsontext.Value `json:"id"`
			Method string         `json:"method"`
		}
		body, err := io.ReadAll(r.Body)
		if err != nil || json.Unmarshal(body, &message) != nil {
			http.Error(w, "not a request", http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		switch {
		case message.Method == "initialize":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(message.ID) + `,"result":{` +
				`"protocolVersion":"2025-11-25","serverInfo":{"name":"notes","version":"1.0.0"},` +
				`"capabilities":{"extensions":{"` + extensionID + `":` + advertised + `}}}}`))
		case message.ID == nil:
			w.WriteHeader(http.StatusAccepted)
		default:
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(message.ID) +
				`,"error":{"code":-32601,"message":"method not found"}}`))
		}
	}))
	t.Cleanup(older.Close)

	config, _ := testConfig(t, operator)
	config.Endpoint = older.URL

	_, err := Connect(t.Context(), config)
	require.ErrorIs(t, err, ErrExtension)
}

func TestConnect_AServerWithoutCapabilities(t *testing.T) {
	operator := testServe(t)
	operator.alter = func(_ string, body []byte) []byte {
		return bytes.Replace(body, []byte(`"capabilities":`), []byte(`"other":`), 1)
	}
	config, _ := testConfig(t, operator)

	_, err := Connect(t.Context(), config)
	require.ErrorIs(t, err, ErrExtension)
}

func TestConnect_AServerWithoutTheExtension(t *testing.T) {
	server := mcp.NewServer(&mcp.Implementation{Name: "notes", Version: "1.0.0"}, nil)
	handler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true},
	)
	plain := httptest.NewServer(handler)
	t.Cleanup(plain.Close)

	config, _ := testConfig(t, testServe(t))
	config.Endpoint = plain.URL

	_, err := Connect(t.Context(), config)
	require.ErrorIs(t, err, ErrExtension)
}

func TestConnect_AnAdvertisementThatIsNotValid(t *testing.T) {
	tests := map[string]string{
		"a custody level S-PAL does not define": `"custody":"nowhere",`,
		"no custody level":                      ``,
	}

	for name, custody := range tests {
		t.Run(name, func(t *testing.T) {
			operator := testServe(t)
			operator.alter = func(_ string, body []byte) []byte {
				return bytes.Replace(body, []byte(`"custody":"federated_operator",`), []byte(custody), 1)
			}
			config, _ := testConfig(t, operator)

			_, err := Connect(t.Context(), config)
			require.ErrorIs(t, err, ErrExtension)
		})
	}
}

func TestConnect_AnotherOperator(t *testing.T) {
	operator := testServe(t)
	config, _ := testConfig(t, operator)
	other, err := didkey.FromPublicKey(
		ed25519.NewKeyFromSeed(bytes.Repeat([]byte{2}, ed25519.SeedSize)).Public().(ed25519.PublicKey),
	)
	require.NoError(t, err)
	config.Operator = other

	_, err = Connect(t.Context(), config)
	require.ErrorIs(t, err, ErrOperator)
}

func TestConnect_Config(t *testing.T) {
	operator := testServe(t)

	tests := map[string]func(*Config){
		"a negative response limit":       func(c *Config) { c.MaxResponseBytes = -1 },
		"a short audit key":               func(c *Config) { c.AuditKey = c.AuditKey[:receipt.AuditKeyMinBytes-1] },
		"an endpoint that is not a URL":   func(c *Config) { c.Endpoint = "://" },
		"an endpoint with another scheme": func(c *Config) { c.Endpoint = "ftp://example.com" },
		"an operator that is not a DID":   func(c *Config) { c.Operator = "notes.example" },
		"no record":                       func(c *Config) { c.Record = nil },
		"terms that are not terms":        func(c *Config) { c.Terms = []byte(`{"version":1}`) },
	}

	for name, change := range tests {
		t.Run(name, func(t *testing.T) {
			config, _ := testConfig(t, operator)
			change(&config)

			_, err := Connect(t.Context(), config)
			require.ErrorIs(t, err, ErrConfig)
		})
	}
}

// TestSession_CallTool runs a session against the proxy in front of the server of the MCP SDK.
func TestConnect_NoHTTPClient(t *testing.T) {
	operator := testServe(t)
	config, _ := testConfig(t, operator)

	var requests atomic.Int32
	standard := http.DefaultClient
	t.Cleanup(func() { http.DefaultClient = standard })
	http.DefaultClient = &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)

		return http.DefaultTransport.RoundTrip(r)
	})}

	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })
	require.Positive(t, requests.Load(), "the requests were not made with http.DefaultClient")
}

func TestSession_CallTool(t *testing.T) {
	operator := testServe(t)
	config, record := testConfig(t, operator)
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	params := &mcp.CallToolParams{
		Meta:      mcp.Meta{"example.test/trace": "t-1"},
		Name:      "echo",
		Arguments: testEchoInput{Text: "hi <there>"},
	}
	result, err := session.CallTool(t.Context(), "notes/2026", params)
	require.NoError(t, err)

	require.Len(t, result.Tool.Content, 1)
	require.Equal(t, "hi <there>", result.Tool.Content[0].(*mcp.TextContent).Text)
	require.NotContains(t, result.Tool.Meta, keyReceipt)
	require.Equal(t, testEchoInput{Text: "hi <there>"}, params.Arguments, "the caller's parameters were changed")
	require.Equal(t, mcp.Meta{"example.test/trace": "t-1"}, params.Meta, "the caller's parameters were changed")

	parsed, err := terms.Parse([]byte(testTerms))
	require.NoError(t, err)
	hash := parsed.Hash()
	require.Equal(t, operator.did, result.Receipt.OperatorDID)
	require.Equal(t, hex.EncodeToString(hash[:]), result.Receipt.TermsHash)
	require.Equal(t, spal.CustodyFederatedOperator, result.Receipt.Custody)
	require.EqualValues(t, 3600, result.Receipt.RetentionSeconds)

	// The operator did not hold the terms, so the call was sent twice: once without the terms and once with them.
	calls := operator.received()
	require.Len(t, calls, 2)
	first, second := testLabelOf(t, calls[0]), testLabelOf(t, calls[1])
	require.Empty(t, first.Terms)
	require.JSONEq(t, testTerms, string(second.Terms))
	require.NotEqual(t, first.Nonce, second.Nonce)
	require.Equal(t, second.Nonce, result.Receipt.Nonce)
	require.Equal(t, second.Commitment, result.Receipt.Commitment)

	// Each request was recorded before it was sent, under the label it was sent with.
	require.Equal(t, []int{0, 1}, record.before)
	require.Len(t, record.sent, 2)
	for i, call := range calls {
		sent := testLabelOf(t, call)
		require.Equal(t, "notes/2026", sent.ContextScope)
		require.Equal(t, testCommitment(t, sent.Nonce, call), sent.Commitment)

		entry := record.sent[i]
		require.Equal(t, sent.Nonce, hex.EncodeToString(entry.Label.Nonce[:]))
		require.Equal(t, sent.Commitment, hex.EncodeToString(entry.Label.Commitment[:]))
		require.Equal(t, hash, entry.Label.TermsHash)
		require.Equal(t, methodCallTool, entry.Method)
		require.Equal(t, operator.did, entry.Operator)
		require.Equal(t, "notes/2026", entry.Scope)
		require.False(t, entry.Time.IsZero())
	}
	require.Equal(t, []Outcome{OutcomeRefused, OutcomeReceipted}, record.ended(t))

	// The operator holds the terms after the first call, so the next call is sent once.
	_, err = session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.NoError(t, err)
	calls = operator.received()
	require.Len(t, calls, 3)
	third := testLabelOf(t, calls[2])
	require.Empty(t, third.Terms)
	require.Equal(t, testCommitment(t, third.Nonce, calls[2]), third.Commitment)
}

func TestSession_CallTool_ARedirect(t *testing.T) {
	var elsewhere atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { elsewhere.Add(1) }))
	t.Cleanup(other.Close)

	// The operator answers discovery itself and redirects every tool call.
	operator := testServe(t)
	inner, err := url.Parse(operator.url)
	require.NoError(t, err)
	forward := httputil.NewSingleHostReverseProxy(inner)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Mcp-Method") == methodCallTool {
			http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
			return
		}
		forward.ServeHTTP(w, r)
	}))
	t.Cleanup(front.Close)

	config, _ := testConfig(t, operator)
	config.Endpoint = front.URL
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	result, err := session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.Nil(t, result)
	require.Error(t, err)
	require.Zero(t, elsewhere.Load(), "the call was sent to another address")
}

func TestSession_CallTool_AResponseAboveTheLimit(t *testing.T) {
	operator := testServe(t)
	config, record := testConfig(t, operator)
	config.MaxResponseBytes = 2048
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	// A response within the limit is accepted.
	_, err = session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.NoError(t, err)

	result, err := session.CallTool(t.Context(), "notes", &mcp.CallToolParams{
		Name:      "echo",
		Arguments: testEchoInput{Text: strings.Repeat("a", 4096)},
	})
	require.Nil(t, result)
	require.ErrorContains(t, err, errResponseTooLarge.Error())
	require.NotErrorIs(t, err, ErrNotSent)
	require.Equal(t, []Outcome{OutcomeRefused, OutcomeReceipted, OutcomeFailed}, record.ended(t))
}

func TestSession_CallTool_AResultThatAsksForInput(t *testing.T) {
	operator := testServe(t)
	operator.alter = func(method string, body []byte) []byte {
		var message map[string]jsontext.Value
		if method != methodCallTool || json.Unmarshal(body, &message) != nil || message["result"] == nil {
			return body
		}
		var result map[string]jsontext.Value
		require.NoError(t, json.Unmarshal(message["result"], &result))
		result["resultType"], result["inputRequests"] = jsontext.Value(`"input_required"`), jsontext.Value(`{}`)
		encoded, err := json.Marshal(result)
		require.NoError(t, err)
		message["result"] = encoded
		body, err = json.Marshal(message)
		require.NoError(t, err)

		return body
	}
	config, record := testConfig(t, operator)
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	// The result is returned with its receipt, and nothing more is sent on the strength of it.
	result, err := session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.NoError(t, err)
	require.True(t, result.Tool.NeedsInput())
	require.Len(t, operator.received(), 2)
	require.Equal(t, []Outcome{OutcomeRefused, OutcomeReceipted}, record.ended(t))
}

func TestSession_CallTool_AStreamAboveTheLimit(t *testing.T) {
	// The operator answers discovery itself and answers every other request with a stream above the limit.
	operator := testServe(t)
	inner, err := url.Parse(operator.url)
	require.NoError(t, err)
	forward := httputil.NewSingleHostReverseProxy(inner)
	var streams atomic.Int32
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Mcp-Method") == "server/discover" {
			forward.ServeHTTP(w, r)
			return
		}
		streams.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		for id := range 8 {
			_, _ = fmt.Fprintf(w, "id: %d\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\","+
				"\"params\":{\"level\":\"info\",\"data\":\"%s\"}}\n\n", id, strings.Repeat("a", 512))
			w.(http.Flusher).Flush()
		}
		// The stream stays open, so only the limit ends the call before its deadline.
		<-r.Context().Done()
	}))
	t.Cleanup(front.Close)

	config, _ := testConfig(t, operator)
	config.Endpoint = front.URL
	config.MaxResponseBytes = 2048
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, "notes", &mcp.CallToolParams{Name: "echo"})
	require.Nil(t, result)
	require.Error(t, err)
	require.NoError(t, ctx.Err(), "the call ended only at its deadline")
	require.EqualValues(t, 1, streams.Load(), "the stream was read again from the start of its limit")
}

func TestSession_CallTool_AnErrorFromTheServer(t *testing.T) {
	operator := testServe(t)
	config, record := testConfig(t, operator)
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	result, err := session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "no such tool"})
	require.Nil(t, result)
	require.NotErrorIs(t, err, ErrNotSent)
	_, ok := errors.AsType[*jsonrpc.Error](err)
	require.True(t, ok, "want a JSON-RPC error, got %v", err)
	_, ok = errors.AsType[*Refusal](err)
	require.False(t, ok, "an error that is not a refusal was read as one")
	require.Contains(t, record.ended(t), OutcomeFailed)
}

func TestSession_CallTool_NotRecorded(t *testing.T) {
	operator := testServe(t)
	config, record := testConfig(t, operator)
	record.err = errors.New("the disk is full")
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	_, err = session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.ErrorIs(t, err, ErrNotSent)
	require.ErrorIs(t, err, record.err)
	require.Empty(t, operator.received())
	require.Empty(t, record.outcomes)
}

func TestSession_CallTool_NotRecordedWithItsTerms(t *testing.T) {
	operator := testServe(t)
	config, record := testConfig(t, operator)
	record.after, record.err = 1, errors.New("the disk is full")
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	// The operator received the call once, without the terms, so the call was sent.
	_, err = session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.NotErrorIs(t, err, ErrNotSent)
	require.ErrorIs(t, err, record.err)
	refused, ok := errors.AsType[*Refusal](err)
	require.True(t, ok, "want a refusal, got %v", err)
	require.Equal(t, terms.ReasonTermsUnknown, refused.Reason)
	require.Len(t, operator.received(), 1)
	require.Equal(t, []Outcome{OutcomeRefused}, record.ended(t))
}

func TestSession_CallTool_NotSent(t *testing.T) {
	tests := map[string]struct {
		condition string
		reason    terms.Reason
		scope     string
	}{
		"a rule beyond the operator's tolerance": {
			condition: "custody",
			reason:    terms.ReasonCannotHonor,
			scope:     "home",
		},
		"a rule that requires attestation": {
			condition: "attestation", reason: terms.ReasonCannotHonor, scope: "sealed",
		},
		"a scope no rule governs": {reason: terms.ReasonScopeNotGoverned, scope: "photos"},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			operator := testServe(t)
			config, record := testConfig(t, operator)
			session, err := Connect(t.Context(), config)
			require.NoError(t, err)
			t.Cleanup(func() { _ = session.Close() })

			_, err = session.CallTool(t.Context(), tc.scope, &mcp.CallToolParams{Name: "echo"})
			require.ErrorIs(t, err, ErrNotSent)
			refused, ok := errors.AsType[*terms.Refusal](err)
			require.True(t, ok, "want a refusal, got %v", err)
			require.Equal(t, tc.reason, refused.Reason)
			require.Equal(t, tc.condition, refused.Condition)

			require.Empty(t, operator.received())
			require.Empty(t, record.sent)
		})
	}
}

func TestSession_CallTool_OutcomeNotRecorded(t *testing.T) {
	operator := testServe(t)
	config, record := testConfig(t, operator)
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })
	_, err = session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.NoError(t, err)
	record.outcomeErr = errors.New("the disk is full")

	// The operator holds the terms, so the call is served, and its result is valid.
	result, err := session.CallTool(
		t.Context(), "notes", &mcp.CallToolParams{Name: "echo", Arguments: testEchoInput{Text: "hi"}},
	)
	require.ErrorIs(t, err, ErrOutcomeNotRecorded)
	require.ErrorIs(t, err, record.outcomeErr)
	require.NotErrorIs(t, err, ErrNotSent)
	require.NotNil(t, result)
	require.Equal(t, "hi", result.Tool.Content[0].(*mcp.TextContent).Text)
	require.Equal(t, operator.did, result.Receipt.OperatorDID)

	// A call that ends in an error keeps that error.
	result, err = session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "no such tool"})
	require.Nil(t, result)
	require.ErrorIs(t, err, ErrOutcomeNotRecorded)
	_, ok := errors.AsType[*jsonrpc.Error](err)
	require.True(t, ok, "want a JSON-RPC error, got %v", err)
}

func TestSession_CallTool_OutcomeNotRecordedWithoutItsTerms(t *testing.T) {
	operator := testServe(t)
	config, record := testConfig(t, operator)
	record.outcomeErr = errors.New("the disk is full")
	session, err := Connect(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	// The operator does not hold the terms, and the call is not sent again while the record fails.
	result, err := session.CallTool(t.Context(), "notes", &mcp.CallToolParams{Name: "echo"})
	require.Nil(t, result)
	require.ErrorIs(t, err, ErrOutcomeNotRecorded)
	require.ErrorIs(t, err, record.outcomeErr)
	refused, ok := errors.AsType[*Refusal](err)
	require.True(t, ok, "want a refusal, got %v", err)
	require.Equal(t, terms.ReasonTermsUnknown, refused.Reason)
	require.Len(t, operator.received(), 1)
}

func TestSession_CallTool_Refused(t *testing.T) {
	const chosen = "text the operator chose"

	tests := map[string]struct {
		alter func(method string, body []byte) []byte
		check func(t *testing.T, err error)
	}{
		"a reason the extension does not define": {
			alter: func(_ string, body []byte) []byte {
				return bytes.Replace(body, []byte(`"reason":"cannot_honour"`), []byte(`"reason":"`+chosen+`"`), 1)
			},
			check: func(t *testing.T, err error) {
				t.Helper()
				refused, ok := errors.AsType[*Refusal](err)
				require.True(t, ok, "want a refusal, got %v", err)
				require.Empty(t, refused.Reason)
				require.Empty(t, refused.Condition)
			},
		},
		"a rule beyond the tolerance the operator applies": {
			alter: func(_ string, body []byte) []byte {
				return bytes.Replace(body, []byte(`"condition":"custody"`), []byte(`"condition":"`+chosen+`"`), 1)
			},
			check: func(t *testing.T, err error) {
				t.Helper()
				refused, ok := errors.AsType[*Refusal](err)
				require.True(t, ok, "want a refusal, got %v", err)
				require.Equal(t, terms.ReasonCannotHonor, refused.Reason)
				require.Equal(t, chosen, refused.Condition)
			},
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			// The operator advertises a custody level nearer than the one it applies, so only the operator refuses.
			operator := testServe(t)
			operator.alter = func(method string, body []byte) []byte {
				body = bytes.Replace(
					body, []byte(`"custody":"federated_operator"`), []byte(`"custody":"owned_hardware"`), 1,
				)

				return tc.alter(method, body)
			}
			config, record := testConfig(t, operator)
			session, err := Connect(t.Context(), config)
			require.NoError(t, err)
			t.Cleanup(func() { _ = session.Close() })

			result, err := session.CallTool(t.Context(), "home", &mcp.CallToolParams{Name: "echo"})
			require.Nil(t, result)
			require.NotErrorIs(t, err, ErrNotSent)
			tc.check(t, err)
			require.NotContains(t, err.Error(), chosen)

			// The operator refused for terms it does not hold, then for the rule.
			require.Len(t, operator.received(), 2)
			require.Equal(t, []Outcome{OutcomeRefused, OutcomeRefused}, record.ended(t))
		})
	}
}

func TestSession_CallTool_Unreceipted(t *testing.T) {
	tests := map[string]struct {
		alter  func(t *testing.T, result map[string]jsontext.Value)
		reason receipt.Reason
	}{
		"a receipt for another request": {
			alter: func(t *testing.T, result map[string]jsontext.Value) {
				t.Helper()
				signed, err := receipt.Sign(testKey, receipt.Statement{
					Conditions: spal.Conditions{
						Aggregation: spal.AggregationForbidden,
						Custody:     spal.CustodyFederatedOperator,
						Resale:      spal.ResaleForbidden,
						Training:    spal.TrainingForbidden,
					},
					ServedAt: time.Now(),
				})
				require.NoError(t, err)
				testSetMeta(t, result, func(meta map[string]jsontext.Value) {
					encoded, err := json.Marshal(signed)
					require.NoError(t, err)
					meta[keyReceipt] = encoded
				})
			},
			reason: receipt.ReasonTerms,
		},
		"a receipt with a signature that does not verify": {
			alter: func(t *testing.T, result map[string]jsontext.Value) {
				t.Helper()
				testSetMeta(t, result, func(meta map[string]jsontext.Value) {
					var signed receipt.Receipt
					require.NoError(t, json.Unmarshal(meta[keyReceipt], &signed))
					signed.RetentionSeconds--
					encoded, err := json.Marshal(signed)
					require.NoError(t, err)
					meta[keyReceipt] = encoded
				})
			},
			reason: receipt.ReasonSignature,
		},
		"no metadata": {
			alter:  func(_ *testing.T, result map[string]jsontext.Value) { delete(result, "_meta") },
			reason: receipt.ReasonMissing,
		},
		"no receipt": {
			alter: func(t *testing.T, result map[string]jsontext.Value) {
				t.Helper()
				testSetMeta(t, result, func(meta map[string]jsontext.Value) { delete(meta, keyReceipt) })
			},
			reason: receipt.ReasonMissing,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			operator := testServe(t)
			operator.alter = func(method string, body []byte) []byte {
				var message map[string]jsontext.Value
				if method != methodCallTool || json.Unmarshal(body, &message) != nil || message["result"] == nil {
					return body
				}
				var result map[string]jsontext.Value
				require.NoError(t, json.Unmarshal(message["result"], &result))
				tc.alter(t, result)
				encoded, err := json.Marshal(result)
				require.NoError(t, err)
				message["result"] = encoded
				body, err = json.Marshal(message)
				require.NoError(t, err)

				return body
			}
			config, record := testConfig(t, operator)
			session, err := Connect(t.Context(), config)
			require.NoError(t, err)
			t.Cleanup(func() { _ = session.Close() })

			result, err := session.CallTool(
				t.Context(), "notes", &mcp.CallToolParams{Name: "echo", Arguments: testEchoInput{Text: "hi"}},
			)
			require.Nil(t, result)
			require.ErrorIs(t, err, ErrUnreceipted)
			require.Equal(t, []Outcome{OutcomeRefused, OutcomeUnreceipted}, record.ended(t))
			refused, ok := errors.AsType[*receipt.Refusal](err)
			require.True(t, ok, "want a receipt refusal, got %v", err)
			require.Equal(t, tc.reason, refused.Reason)
		})
	}
}

// testCommitment returns, in lowercase hex, the commitment the specification defines for the tool call wire.
// It is computed for the test audit key, the test operator and the nonce given in lowercase hex.
func testCommitment(t *testing.T, nonce string, wire testWire) string {
	t.Helper()

	var params map[string]jsontext.Value
	require.NoError(t, json.Unmarshal(wire.Params, &params))
	delete(params, "_meta")
	request, err := json.Marshal(map[string]any{"method": wire.Method, "params": params})
	require.NoError(t, err)
	canonical := jsontext.Value(request)
	require.NoError(t, canonical.Canonicalize())

	did, err := didkey.FromPublicKey(testKey.Public().(ed25519.PublicKey))
	require.NoError(t, err)
	rawNonce, err := hex.DecodeString(nonce)
	require.NoError(t, err)

	requestKey := hmac.New(sha256.New, testAuditKey)
	requestKey.Write([]byte("spal/receipt/v1\x00" + did + "\x00"))
	requestKey.Write(rawNonce)
	commitment := hmac.New(sha256.New, requestKey.Sum(nil))
	commitment.Write(canonical)

	return hex.EncodeToString(commitment.Sum(nil))
}

// testConfig returns a configuration for a session with operator, and the record the configuration names.
func testConfig(t *testing.T, operator *testOperator) (Config, *testRecord) {
	t.Helper()

	record := &testRecord{operator: operator}

	return Config{
		AuditKey: testAuditKey,
		Endpoint: operator.url,
		Operator: operator.did,
		Record:   record,
		Terms:    []byte(testTerms),
	}, record
}

// testLabelOf returns the terms label that the tool call wire carries.
func testLabelOf(t *testing.T, wire testWire) label {
	t.Helper()

	var params map[string]jsontext.Value
	require.NoError(t, json.Unmarshal(wire.Params, &params))
	var meta map[string]jsontext.Value
	require.NoError(t, json.Unmarshal(params[memberMeta], &meta))
	var sent label
	require.NoError(t, json.Unmarshal(meta[keyTerms], &sent, json.RejectUnknownMembers(true)))

	return sent
}

// testServe starts an operator: the proxy in front of an MCP server with one tool, which returns its input.
// The operator requires terms and runs at the custody level of a federated operator.
func testServe(t *testing.T) *testOperator {
	t.Helper()

	server := mcp.NewServer(&mcp.Implementation{Name: "notes", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "echo"}, func(
		_ context.Context, _ *mcp.CallToolRequest, input testEchoInput,
	) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: input.Text}}}, nil, nil
	})
	handler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true},
	)
	behind := httptest.NewServer(handler)
	t.Cleanup(behind.Close)
	upstream, err := url.Parse(behind.URL)
	require.NoError(t, err)

	log, err := audit.Open(filepath.Join(t.TempDir(), "audit.jsonl"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = log.Close() })

	p, err := proxy.New(proxy.Config{
		Audit:         log,
		Key:           testKey,
		TermsRequired: true,
		Tolerance: spal.Tolerance{
			Aggregation: spal.AggregationForbidden,
			Custody:     spal.CustodyFederatedOperator,
			Resale:      spal.ResaleForbidden,
			Training:    spal.TrainingForbidden,
		},
		Upstream: upstream,
	})
	require.NoError(t, err)

	operator := &testOperator{}
	operator.did, err = didkey.FromPublicKey(testKey.Public().(ed25519.PublicKey))
	require.NoError(t, err)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		operator.serve(p, w, r)
	}))
	t.Cleanup(front.Close)
	operator.url = front.URL

	return operator
}

// testSetMeta applies change to the metadata of result.
func testSetMeta(t *testing.T, result map[string]jsontext.Value, change func(meta map[string]jsontext.Value)) {
	t.Helper()

	var meta map[string]jsontext.Value
	require.NoError(t, json.Unmarshal(result["_meta"], &meta))
	change(meta)
	encoded, err := json.Marshal(meta)
	require.NoError(t, err)
	result["_meta"] = encoded
}
