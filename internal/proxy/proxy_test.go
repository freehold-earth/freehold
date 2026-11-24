package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json/v2"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/audit"
	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/receipt"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

const (
	// testCapabilities is the metadata of a client that lists the terms extension.
	testCapabilities = `"io.modelcontextprotocol/clientCapabilities":{"extensions":{"earth.freehold/spal":{}}}`

	// testCommitment is the commitment that the test requests carry.
	testCommitment = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

	// testNonce is the nonce that the test requests carry.
	testNonce = "0123456789abcdef0123456789abcdef"

	// testRequestID is the request ID the test proxy gives every request.
	testRequestID = "req-1"

	// testTerms holds one rule, which lets notes go to a federated operator and be kept for one hour.
	testTerms = `{"version":"1.1","rules":[{"context_scope":"notes","conditions":` +
		`{"custody":{"operator":"federated_operator"},"retention":{"max_seconds":3600}}}]}`

	// testTime is the test proxy's current time, in the format of the audit record.
	testTime = "2026-11-17T09:30:00Z"
)

// testConditions is the conditions an operator at the test tolerance commits to under testTerms.
var testConditions = spal.Conditions{
	Custody:          spal.CustodyFederatedOperator,
	RetentionSeconds: 3600,
	Training:         spal.TrainingForbidden,
	Aggregation:      spal.AggregationForbidden,
	Resale:           spal.ResaleForbidden,
}

// testKey is the operator's signing key in tests.
var testKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))

func TestNew_Config(t *testing.T) {
	tests := map[string]func(*Config){
		"a key of the wrong length":        func(c *Config) { c.Key = testKey[:ed25519.SeedSize] },
		"a largest body below zero":        func(c *Config) { c.MaxBodyBytes = -1 },
		"a tolerance S-PAL does not allow": func(c *Config) { c.Tolerance.Training = "sometimes" },
		"an upstream that is not http":     func(c *Config) { c.Upstream = &url.URL{Scheme: "file", Host: "x"} },
		"an upstream with no host":         func(c *Config) { c.Upstream = &url.URL{Scheme: "http"} },
		"no audit record":                  func(c *Config) { c.Audit = nil },
		"no key":                           func(c *Config) { c.Key = nil },
		"no upstream":                      func(c *Config) { c.Upstream = nil },
	}

	for name, change := range tests {
		t.Run(name, func(t *testing.T) {
			log, err := audit.Open(filepath.Join(t.TempDir(), "audit.jsonl"))
			require.NoError(t, err)
			config := Config{
				Audit:     log,
				Key:       testKey,
				Tolerance: testTolerance(t),
				Upstream:  &url.URL{Scheme: "http", Host: "127.0.0.1:1"},
			}
			_, err = New(config)
			require.NoError(t, err)

			change(&config)
			_, err = New(config)
			require.ErrorIs(t, err, ErrConfig)
		})
	}
}

func TestProxy_AuditUnavailable(t *testing.T) {
	p, auditPath := testProxy(t, func(http.ResponseWriter, *http.Request) {
		t.Error("a request with no audit line reached the server")
	}, nil)
	require.NoError(t, p.audit.(*audit.Log).Close())

	resp := testPost(t, p, testRequest(t, "tools/call", testLabel(t, testTerms, "notes", true)))

	require.Equal(t, http.StatusInternalServerError, resp.Code)
	require.JSONEq(t, `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"internal error"}}`, resp.Body.String())
	require.Empty(t, testRead(t, auditPath))
}

func TestProxy_BodyNeverEnds(t *testing.T) {
	t.Parallel()

	p, auditPath := testProxy(t, func(http.ResponseWriter, *http.Request) {
		t.Error("the request reached the server behind")
	}, nil)
	server := httptest.NewUnstartedServer(p)
	server.Config.ReadTimeout = 50 * time.Millisecond
	server.Start()
	t.Cleanup(server.Close)

	var dialer net.Dialer
	conn, err := dialer.DialContext(t.Context(), "tcp", server.Listener.Addr().String())
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	// The Content-Length header declares more bytes than the request sends.
	_, err = io.WriteString(conn, "POST /mcp HTTP/1.1\r\nHost: operator.example\r\n"+
		"Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"jsonrpc\":")
	require.NoError(t, err)

	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	require.NoError(t, err)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusRequestTimeout, resp.StatusCode)
	require.JSONEq(
		t,
		`{"jsonrpc":"2.0","error":{"code":-32600,"message":"the request could not be read"}}`,
		string(body),
	)
	require.Empty(t, testRead(t, auditPath))
}

func TestProxy_Discover(t *testing.T) {
	did, err := didkey.FromPublicKey(testKey.Public().(ed25519.PublicKey))
	require.NoError(t, err)
	advertised := `{"operator_did":"` + did + `","custody":"federated_operator","retention_min_seconds":0,` +
		`"training":"forbidden","aggregation":"forbidden","resale":"forbidden","terms":"required"}`

	tests := map[string]struct {
		result string
		want   string
	}{
		"a server that says nothing of its capabilities": {
			result: `{"supportedVersions":["2026-07-28"]}`,
			want:   `{"supportedVersions":["2026-07-28"],"capabilities":{"extensions":{"earth.freehold/spal":` + advertised + `}}}`,
		},
		"a server with another extension keeps it": {
			result: `{"capabilities":{"extensions":{"com.example/other":{"a":1}}}}`,
			want: `{"capabilities":{"extensions":{"com.example/other":{"a":1},` +
				`"earth.freehold/spal":` + advertised + `}}}`,
		},
		"a server with no extensions of its own": {
			result: `{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}}}`,
			want: `{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{},` +
				`"extensions":{"earth.freehold/spal":` + advertised + `}}}`,
		},
		"what a server says for the operator is replaced": {
			result: `{"capabilities":{"extensions":{"earth.freehold/spal":{"operator_did":"did:key:z6MkOther"}}}}`,
			want:   `{"capabilities":{"extensions":{"earth.freehold/spal":` + advertised + `}}}`,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			p, auditPath := testProxy(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7,"result":`+tc.result+`}`)
			}, nil)

			resp := testPost(t, p, `{"jsonrpc":"2.0","id":7,"method":"server/discover","params":{"_meta":{}}}`)

			require.Equal(t, http.StatusOK, resp.Code)
			require.JSONEq(t, `{"jsonrpc":"2.0","id":7,"result":`+tc.want+`}`, resp.Body.String())
			require.Equal(t, fmt.Sprint(resp.Body.Len()), resp.Header().Get("Content-Length"))
			require.Empty(t, testRead(t, auditPath))
		})
	}
}

func TestProxy_HeaderMismatch(t *testing.T) {
	p, _ := testProxy(t, func(http.ResponseWriter, *http.Request) {
		t.Error("a request that gives two accounts of itself reached the server")
	}, nil)

	req := httptest.NewRequest(
		http.MethodPost,
		"/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call"}`),
	)
	req.Header.Set("Mcp-Method", "tools/list")
	resp := httptest.NewRecorder()
	p.ServeHTTP(resp, req)

	require.Equal(t, http.StatusBadRequest, resp.Code)
	require.JSONEq(t, `{"jsonrpc":"2.0","id":7,"error":{"code":-32020,"message":`+
		`"Header mismatch: Mcp-Method does not match the method in the body"}}`, resp.Body.String())
}

func TestProxy_NotARequest(t *testing.T) {
	tests := map[string]struct {
		body       string
		want       string
		wantStatus int
	}{
		"a commitment claimed in other letter case": {
			body: `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":` +
				`{"Earth.Freehold/Commitment":{"training":"allowed"}}}}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"a member given twice": {
			body:       `{"jsonrpc":"2.0","id":1,"method":"tools/list","method":"tools/call"}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"a member the proxy reads, in other letter case": {
			body:       `{"jsonrpc":"2.0","id":1,"method":"tools/list","Method":"tools/call"}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"a method longer than a name may be": {
			body:       `{"jsonrpc":"2.0","id":1,"method":"` + strings.Repeat("m", 257) + `"}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"a request larger than the proxy reads": {
			body: `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"` + strings.Repeat(
				"x",
				2048,
			) + `"}}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32600,"message":"the request could not be read"}}`,
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		"an id that is a fraction": {
			body:       `{"jsonrpc":"2.0","id":7.5,"method":"tools/list"}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"an id that is a number with an exponent": {
			body:       `{"jsonrpc":"2.0","id":1e999999999,"method":"tools/list"}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"an id that is neither text nor a number": {
			body:       `{"jsonrpc":"2.0","id":{"a":1},"method":"tools/list"}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"an id that is null": {
			body:       `{"jsonrpc":"2.0","id":null,"method":"tools/list"}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"an object with no method": {
			body:       `{"jsonrpc":"2.0","id":1}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"metadata given twice": {
			body:       `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{},"_meta":{}}}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"metadata in other letter case": {
			body:       `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_Meta":{}}}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"metadata that is not an object": {
			body:       `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":5}}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"parameters in other letter case": {
			body:       `{"jsonrpc":"2.0","id":1,"method":"tools/call","PARAMS":{"name":"echo"}}`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"several requests in one": {
			body:       `[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]`,
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
		"text that is not JSON": {
			body:       "hello",
			want:       `{"jsonrpc":"2.0","error":{"code":-32700,"message":"not a JSON-RPC request"}}`,
			wantStatus: http.StatusBadRequest,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			p, _ := testProxy(t, func(http.ResponseWriter, *http.Request) {
				t.Error("something that is not a request reached the server")
			}, func(c *Config) { c.MaxBodyBytes = 1024 })

			resp := testPost(t, p, tc.body)

			require.Equal(t, tc.wantStatus, resp.Code)
			require.JSONEq(t, tc.want, resp.Body.String())
		})
	}
}

func TestProxy_Plain(t *testing.T) {
	const answer = `{"jsonrpc":"2.0","id":7,"result":{"content":[]}}`

	tests := map[string]struct {
		body     string
		required bool
		wantSent string
	}{
		"a request does not get to say what the operator committed to": {
			body: `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"echo","_meta":` +
				`{"earth.freehold/commitment":{"training":"allowed"},"other":1}}}`,
			wantSent: `{"id":7,"jsonrpc":"2.0","method":"tools/call","params":{"_meta":{"other":1},"name":"echo"}}`,
		},
		"an operator that does not require terms passes a data-carrying request as it came": {
			body:     `{"method":"tools/call", "id":7,"jsonrpc":"2.0","params":{"name":"echo","_meta":{"b":1,"a":2}}}`,
			wantSent: `{"method":"tools/call", "id":7,"jsonrpc":"2.0","params":{"name":"echo","_meta":{"b":1,"a":2}}}`,
		},
		"an operator that requires terms still serves a request that carries no data": {
			body:     `{"jsonrpc":"2.0","id":7,"method":"tools/list"}`,
			required: true,
			wantSent: `{"jsonrpc":"2.0","id":7,"method":"tools/list"}`,
		},
		"terms from a client that does not list the extension are not acted on": {
			body: `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"_meta":{"earth.freehold/terms":` +
				testLabel(t, testTerms, "notes", true) + `}}}`,
			wantSent: `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"_meta":{"earth.freehold/terms":` +
				testLabel(t, testTerms, "notes", true) + `}}}`,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			var sent string
			p, auditPath := testProxy(t, func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				sent = string(body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, answer)
			}, func(c *Config) { c.TermsRequired = tc.required })

			resp := testPost(t, p, tc.body)

			require.Equal(t, http.StatusOK, resp.Code)
			require.Equal(t, answer, resp.Body.String())
			require.Equal(t, tc.wantSent, sent)
			require.Empty(t, testRead(t, auditPath))
		})
	}
}

func TestProxy_OtherMethods(t *testing.T) {
	const call = `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"echo"}}`

	tests := map[string]struct {
		body       string
		method     string
		upgrade    string
		want       string
		wantStatus int
	}{
		"a DELETE with no body is the server's to answer": {
			method:     http.MethodDelete,
			want:       "DELETE /mcp",
			wantStatus: http.StatusOK,
		},
		"a GET that asks to change protocol": {
			method:     http.MethodGet,
			upgrade:    "websocket",
			want:       "this server does not change protocol\n",
			wantStatus: http.StatusBadRequest,
		},
		"a GET that carries a request": {
			body:       call,
			method:     http.MethodGet,
			want:       "this method carries no body\n",
			wantStatus: http.StatusBadRequest,
		},
		"a GET with no body is the server's to answer": {
			method:     http.MethodGet,
			want:       "GET /mcp",
			wantStatus: http.StatusOK,
		},
		"a PATCH with no body": {
			method:     http.MethodPatch,
			want:       "method not allowed\n",
			wantStatus: http.StatusMethodNotAllowed,
		},
		"a PUT that carries a request": {
			body:       call,
			method:     http.MethodPut,
			want:       "method not allowed\n",
			wantStatus: http.StatusMethodNotAllowed,
		},
		"an OPTIONS with no body is the server's to answer": {
			method:     http.MethodOptions,
			want:       "OPTIONS /mcp",
			wantStatus: http.StatusOK,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			p, _ := testProxy(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.wantStatus != http.StatusOK {
					t.Error("a request the proxy does not pass on reached the server")
				}
				_, _ = io.WriteString(w, r.Method+" "+r.URL.Path)
			}, nil)

			req := httptest.NewRequest(tc.method, "/mcp", strings.NewReader(tc.body))
			if tc.upgrade != "" {
				req.Header.Set("Connection", "Upgrade")
				req.Header.Set("Upgrade", tc.upgrade)
			}
			resp := httptest.NewRecorder()
			p.ServeHTTP(resp, req)

			require.Equal(t, tc.wantStatus, resp.Code)
			require.Equal(t, tc.want, resp.Body.String())
		})
	}
}

func TestProxy_Refuses(t *testing.T) {
	hash := testTermsHash(t, testTerms)
	unknownCondition := `{"version":"1.1","rules":[{"context_scope":"notes","conditions":{"mood":{}}}]}`
	// changed returns the terms label for testTerms with the first occurrence of old replaced by replacement.
	changed := func(old string, replacement string) string {
		return strings.Replace(testLabel(t, testTerms, "notes", true), old, replacement, 1)
	}

	tests := map[string]struct {
		body       string
		tolerance  func(*spal.Tolerance)
		wantAudit  string
		wantError  string
		wantStatus int
	}{
		"a client that does not list the extension is told which capability it lacks": {
			body: `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"echo"}}`,
			wantError: `{"code":-32021,"message":"this server serves this request only under the terms extension ` +
				`earth.freehold/spal","data":{"requiredCapabilities":{"extensions":{"earth.freehold/spal":{}}}}}`,
			wantStatus: http.StatusBadRequest,
		},
		"a client that lists the extension and sends no terms": {
			body:      `{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"_meta":{` + testCapabilities + `}}}`,
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"resources/read","reason":"terms_required"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_required","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_required"}}}`,
			wantStatus: http.StatusOK,
		},
		"a condition the operator does not understand": {
			body: testRequest(t, "tools/call", testLabel(t, unknownCondition, "notes", true)),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","terms_hash":"` +
				testTermsHash(t, unknownCondition) + `","nonce":"` + testNonce +
				`","context_scope":"notes","reason":"condition_not_understood","condition":"mood"}`,
			wantError: `{"code":4030,"message":"terms refused: condition_not_understood: mood","data":` +
				`{"earth.freehold/refusal":{"reason":"condition_not_understood","condition":"mood","terms_hash":"` +
				testTermsHash(t, unknownCondition) + `"}}}`,
			wantStatus: http.StatusOK,
		},
		"a hash that is not lowercase hex": {
			body:      testRequest(t, "tools/call", changed(hash, strings.ToUpper(hash))),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","reason":"terms_malformed"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_malformed","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_malformed"}}}`,
			wantStatus: http.StatusOK,
		},
		"a member the extension does not name": {
			body:      testRequest(t, "tools/call", changed(`"nonce"`, `"extra":1,"nonce"`)),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","reason":"terms_malformed"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_malformed","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_malformed"}}}`,
			wantStatus: http.StatusOK,
		},
		"a nonce of the wrong length": {
			body:      testRequest(t, "tools/call", changed(testNonce, testNonce+"00")),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","reason":"terms_malformed"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_malformed","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_malformed"}}}`,
			wantStatus: http.StatusOK,
		},
		"a rule stricter than the operator is able to keep": {
			body:      testRequest(t, "tools/call", testLabel(t, testTerms, "notes", true)),
			tolerance: func(tolerance *spal.Tolerance) { tolerance.Training = spal.TrainingAllowed },
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","terms_hash":"` + hash +
				`","nonce":"` + testNonce + `","context_scope":"notes","reason":"cannot_honour","condition":"training"}`,
			wantError: `{"code":4030,"message":"terms refused: cannot_honour: training","data":` +
				`{"earth.freehold/refusal":{"reason":"cannot_honour","condition":"training","terms_hash":"` + hash + `"}}}`,
			wantStatus: http.StatusOK,
		},
		"a scope longer than a name may be": {
			body:      testRequest(t, "tools/call", testLabel(t, testTerms, strings.Repeat("s", 257), true)),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","reason":"terms_malformed"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_malformed","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_malformed"}}}`,
			wantStatus: http.StatusOK,
		},
		"a scope no rule governs": {
			body: testRequest(t, "tools/call", testLabel(t, testTerms, "health", true)),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","terms_hash":"` + hash +
				`","nonce":"` + testNonce + `","context_scope":"health","reason":"scope_not_governed"}`,
			wantError: `{"code":4030,"message":"terms refused: scope_not_governed","data":` +
				`{"earth.freehold/refusal":{"reason":"scope_not_governed","terms_hash":"` + hash + `"}}}`,
			wantStatus: http.StatusOK,
		},
		"terms larger than terms are": {
			body: testRequest(t, "tools/call", testLabel(t, `{"version":"1.1","rules":[],"pad":"`+
				strings.Repeat("x", 64<<10)+`"}`, "notes", true)),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","reason":"terms_malformed"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_malformed","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_malformed"}}}`,
			wantStatus: http.StatusOK,
		},
		"terms that are not terms": {
			body: testRequest(t, "tools/call", changed(testTerms, "5")),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","terms_hash":"` + hash +
				`","nonce":"` + testNonce + `","context_scope":"notes","reason":"terms_malformed"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_malformed","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_malformed"}}}`,
			wantStatus: http.StatusOK,
		},
		"terms that do not have the hash named": {
			body: testRequest(t, "tools/call", changed(`"max_seconds":3600`, `"max_seconds":7200`)),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","terms_hash":"` + hash +
				`","nonce":"` + testNonce + `","context_scope":"notes","reason":"terms_mismatch"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_mismatch","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_mismatch","terms_hash":"` + hash + `"}}}`,
			wantStatus: http.StatusOK,
		},
		"terms the operator does not hold": {
			body: testRequest(t, "tools/call", testLabel(t, testTerms, "notes", false)),
			wantAudit: `{"time":"` + testTime + `","outcome":"refused","method":"tools/call","terms_hash":"` + hash +
				`","nonce":"` + testNonce + `","context_scope":"notes","reason":"terms_unknown"}`,
			wantError: `{"code":4030,"message":"terms refused: terms_unknown","data":` +
				`{"earth.freehold/refusal":{"reason":"terms_unknown","terms_hash":"` + hash + `"}}}`,
			wantStatus: http.StatusOK,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			p, auditPath := testProxy(t, func(http.ResponseWriter, *http.Request) {
				t.Error("a refused request reached the server")
			}, func(c *Config) {
				if tc.tolerance != nil {
					tc.tolerance(&c.Tolerance)
				}
			})

			resp := testPost(t, p, tc.body)

			require.Equal(t, tc.wantStatus, resp.Code)
			require.JSONEq(t, `{"jsonrpc":"2.0","id":7,"error":`+tc.wantError+`}`, resp.Body.String())
			want := tc.wantAudit
			if want != "" {
				want += "\n"
			}
			require.Equal(t, want, testRead(t, auditPath))
		})
	}
}

func TestProxy_Serves(t *testing.T) {
	hash := testTermsHash(t, testTerms)
	signed := testReceipt(t)
	accepted := `{"time":"` + testTime + `","outcome":"accepted","method":"tools/call","request_id":"req-1",` +
		`"terms_hash":"` + hash + `","nonce":"` + testNonce + `","context_scope":"notes/2026","conditions":` +
		`{"custody":"federated_operator","retention_seconds":3600,"training":"forbidden",` +
		`"aggregation":"forbidden","resale":"forbidden"}}`
	served := strings.Replace(accepted, `"accepted"`, `"served"`, 1)
	served = served[:len(served)-1] + `,"receipt":` + signed + `}`

	var sent []string
	p, auditPath := testProxy(t, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		sent = append(sent, string(body))
		if r.Header.Get("Accept-Encoding") != "gzip" {
			t.Errorf("the client's Accept-Encoding reached the server: %s", r.Header.Get("Accept-Encoding"))
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7,"result":{"content":[],"_meta":{"other":1}}}`)
	}, nil)

	wantSent := func(label string) string {
		return `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"echo","_meta":{` + testCapabilities +
			`,"earth.freehold/terms":` + label + `,"earth.freehold/commitment":{"request_id":"req-1","terms_hash":"` +
			hash + `","context_scope":"notes/2026","custody":"federated_operator","retention_seconds":3600,` +
			`"training":"forbidden","aggregation":"forbidden","resale":"forbidden"}}}}`
	}
	wantAnswer := `{"jsonrpc":"2.0","id":7,"result":{"content":[],"_meta":{"other":1,"earth.freehold/receipt":` +
		signed + `}}}`

	// The first request sends the terms.
	// The second names them by hash and carries a commitment of its own.
	withTerms := testLabel(t, testTerms, "notes/2026", true)
	byHash := testLabel(t, testTerms, "notes/2026", false)
	claiming := strings.Replace(testRequest(t, "tools/call", byHash), `"_meta":{`,
		`"_meta":{"earth.freehold/commitment":{"training":"allowed"},`, 1)

	for i, body := range []string{testRequest(t, "tools/call", withTerms), claiming} {
		resp := testPost(t, p, body)

		require.Equal(t, http.StatusOK, resp.Code)
		require.JSONEq(t, wantAnswer, resp.Body.String())
		require.Equal(t, fmt.Sprint(resp.Body.Len()), resp.Header().Get("Content-Length"))
		require.Len(t, sent, i+1)
	}

	require.JSONEq(t, wantSent(withTerms), sent[0])
	require.JSONEq(t, wantSent(byHash), sent[1])
	require.Equal(t, strings.Repeat(accepted+"\n"+served+"\n", 2), testRead(t, auditPath))
}

func TestProxy_ServesStream(t *testing.T) {
	const progress = `{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}`
	signed := testReceipt(t)

	p, auditPath := testProxy(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": a comment\n\nevent: message\nid: 1\ndata: "+progress+"\n\n")
		_, _ = io.WriteString(
			w,
			"event: message\r\nid: 2\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\r\ndata: \"result\":{\"content\":[]}}\r\n\r\n",
		)
	}, nil)

	resp := testPost(t, p, testRequest(t, "tools/call", testLabel(t, testTerms, "notes/2026", true)))

	require.Equal(t, http.StatusOK, resp.Code)
	require.Equal(t, "text/event-stream", resp.Header().Get("Content-Type"))
	require.Equal(t, ": a comment\n\nevent: message\nid: 1\ndata: "+progress+"\n\n"+
		`event: message`+"\n"+`id: 2`+"\n"+`data: {"id":7,"jsonrpc":"2.0","result":{"_meta":{"earth.freehold/receipt":`+
		signed+`},"content":[]}}`+"\n\n", resp.Body.String())

	lines := strings.Split(strings.TrimSpace(testRead(t, auditPath)), "\n")
	require.Len(t, lines, 2)
	require.Contains(t, lines[0], `"outcome":"accepted"`)
	require.Contains(t, lines[1], `"outcome":"served"`)
	require.Contains(t, lines[1], `"receipt":`+signed)
}

func TestProxy_ServesStreamAroundOtherEvents(t *testing.T) {
	signed := testReceipt(t)

	tests := map[string]struct {
		stream string
		want   string
	}{
		"a stream that opens with a byte order mark": {
			stream: "\ufeffdata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n\n",
			want: `data: {"id":7,"jsonrpc":"2.0","result":{"_meta":` +
				`{"earth.freehold/receipt":` + signed + `}}}` + "\n\n",
		},
		"an event whose data is not JSON passes as it came": {
			stream: "data: ping\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n\n",
			want: "data: ping\n\n" + `data: {"id":7,"jsonrpc":"2.0","result":{"_meta":` +
				`{"earth.freehold/receipt":` + signed + `}}}` + "\n\n",
		},
		"an event with empty data, sent to prime the stream, passes as it came": {
			stream: "event: prime\nid: 1_0\ndata: \n\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n\n",
			want: "event: prime\nid: 1_0\ndata: \n\n" + `data: {"id":7,"jsonrpc":"2.0","result":{"_meta":` +
				`{"earth.freehold/receipt":` + signed + `}}}` + "\n\n",
		},
		"an id written another way is the same id": {
			stream: "data: {\"jsonrpc\":\"2.0\",\"id\":7.0,\"result\":{}}\n\n",
			want: `data: {"id":7.0,"jsonrpc":"2.0","result":{"_meta":` +
				`{"earth.freehold/receipt":` + signed + `}}}` + "\n\n",
		},
		"line endings that are carriage returns alone": {
			stream: "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\r\r",
			want: `data: {"id":7,"jsonrpc":"2.0","result":{"_meta":` +
				`{"earth.freehold/receipt":` + signed + `}}}` + "\n\n",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			p, auditPath := testProxy(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, tc.stream)
			}, nil)

			resp := testPost(t, p, testRequest(t, "tools/call", testLabel(t, testTerms, "notes/2026", true)))

			require.Equal(t, tc.want, resp.Body.String())
			require.Contains(t, testRead(t, auditPath), `"outcome":"served"`)
		})
	}
}

func TestProxy_ServesStreamLeftOpen(t *testing.T) {
	signed := testReceipt(t)
	want := `data: {"id":7,"jsonrpc":"2.0","result":{"_meta":{"earth.freehold/receipt":` + signed + `}}}` + "\n\n"

	tests := map[string]string{
		"lines that end in a carriage return alone": "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\r\r",
		"lines that end in a line feed":             "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n\n",
		"lines that end in both":                    "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\r\n\r\n",
	}

	for name, stream := range tests {
		t.Run(name, func(t *testing.T) {
			// The server sends its result and then keeps the stream open until the test has read it.
			read := make(chan struct{})
			p, _ := testProxy(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, stream)
				_ = http.NewResponseController(w).Flush()
				<-read
			}, nil)
			front := httptest.NewServer(p)
			t.Cleanup(front.Close)
			t.Cleanup(func() { close(read) })

			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			t.Cleanup(cancel)
			body := testRequest(t, "tools/call", testLabel(t, testTerms, "notes/2026", true))
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, front.URL, strings.NewReader(body))
			require.NoError(t, err)
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			t.Cleanup(func() { _ = resp.Body.Close() })

			got := make([]byte, len(want))
			_, err = io.ReadFull(resp.Body, got)
			require.NoError(t, err, "the result did not arrive while the stream was open")
			require.Equal(t, want, string(got))
		})
	}
}

func TestProxy_ServesStreamOneReceipt(t *testing.T) {
	const result = `{"jsonrpc":"2.0","id":7,"result":{"content":[]}}`
	const rpcError = `{"jsonrpc":"2.0","id":7,"error":{"code":-32602,"message":"no such tool"}}`
	signed := testReceipt(t)
	receipted := `data: {"id":7,"jsonrpc":"2.0","result":{"_meta":{"earth.freehold/receipt":` + signed +
		`},"content":[]}}` + "\n\n"

	tests := map[string]struct {
		stream      string
		want        string
		wantOutcome string
	}{
		"a result after an error is not passed on, and earns no receipt": {
			stream:      "data: " + rpcError + "\n\ndata: " + result + "\n\n",
			want:        "data: " + rpcError + "\n\n",
			wantOutcome: "failed",
		},
		"a result for some other request is not passed on, and earns no receipt": {
			stream:      "data: {\"jsonrpc\":\"2.0\",\"id\":999,\"result\":{}}\n\ndata: " + result + "\n\n",
			want:        "",
			wantOutcome: "failed",
		},
		"a second result is not passed on, and earns no second receipt": {
			stream:      "data: " + result + "\n\ndata: " + result + "\n\n",
			want:        receipted,
			wantOutcome: "served",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			p, auditPath := testProxy(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, tc.stream)
			}, nil)

			resp := testPost(t, p, testRequest(t, "tools/call", testLabel(t, testTerms, "notes/2026", true)))

			require.Equal(t, tc.want, resp.Body.String())
			lines := strings.Split(strings.TrimSpace(testRead(t, auditPath)), "\n")
			require.Len(t, lines, 2)
			require.Contains(t, lines[1], `"outcome":"`+tc.wantOutcome+`"`)
		})
	}
}

func TestProxy_Unreceipted(t *testing.T) {
	const rpcError = `{"jsonrpc":"2.0","id":7,"error":{"code":-32602,"message":"no such tool"}}`

	tests := map[string]struct {
		upstream   http.HandlerFunc
		want       string
		wantStatus int
	}{
		"the server answers a request with a notification": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","method":"notifications/progress"}`)
			},
			want:       `{"jsonrpc":"2.0","method":"notifications/progress"}`,
			wantStatus: http.StatusOK,
		},
		"the server answers some other request": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":8,"result":{}}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server answers with JSON that is not a message": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `[1,2]`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server answers with an error": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, rpcError)
			},
			want:       rpcError,
			wantStatus: http.StatusOK,
		},
		"the server answers with an error on a stream": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: "+rpcError+"\n\n")
			},
			want:       "data: " + rpcError + "\n\n",
			wantStatus: http.StatusOK,
		},
		"the server answers with an error that names no request": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"bad"}}`)
			},
			want:       `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"bad"}}`,
			wantStatus: http.StatusOK,
		},
		"the server answers with an id one digit off, beyond what a float holds": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7.0000000000000000000001,"result":{}}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server answers with an id written with an exponent": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7e999999999,"result":{}}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server answers with more than the proxy reads": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7,"result":{"pad":"`+strings.Repeat("x", 4096)+`"}}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server answers with something that is not MCP": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(w, "down")
			},
			want:       "down",
			wantStatus: http.StatusServiceUnavailable,
		},
		"the server answers with the same id rewritten with an exponent": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7e0,"result":{}}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server changes protocol": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Connection", "Upgrade")
				w.Header().Set("Upgrade", "websocket")
				w.WriteHeader(http.StatusSwitchingProtocols)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server's result has metadata that is not an object": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7,"result":{"_meta":5}}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server's result has metadata that is null": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7,"result":{"_meta":null}}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server's result is null": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":7,"result":null}`)
			},
			want:       `{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
			wantStatus: http.StatusBadGateway,
		},
		"the server's stream ends in the middle of the event that holds the result": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, `data: {"jsonrpc":"2.0","id":7,"result":{}}`)
			},
			want:       "",
			wantStatus: http.StatusOK,
		},
		"the server's stream ends with no response": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, ": nothing\n\n")
			},
			want:       ": nothing\n\n",
			wantStatus: http.StatusOK,
		},
		"the server's stream holds a line longer than the proxy reads": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, ": first\n\ndata: "+strings.Repeat("x", 4096)+"\n\n")
			},
			want:       ": first\n\n",
			wantStatus: http.StatusOK,
		},
		"the server's stream holds an event larger than the proxy reads": {
			upstream: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, ": first\n\n"+strings.Repeat("data: "+strings.Repeat("x", 1000)+"\n", 3)+"\n")
			},
			want:       ": first\n\n",
			wantStatus: http.StatusOK,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			p, auditPath := testProxy(t, tc.upstream, func(c *Config) { c.MaxBodyBytes = 2048 })

			resp := testPost(t, p, testRequest(t, "tools/call", testLabel(t, testTerms, "notes", true)))

			require.Equal(t, tc.wantStatus, resp.Code)
			require.Equal(t, tc.want, resp.Body.String())

			lines := strings.Split(strings.TrimSpace(testRead(t, auditPath)), "\n")
			require.Len(t, lines, 2)
			require.Contains(t, lines[0], `"outcome":"accepted"`)
			require.Contains(t, lines[1], `"outcome":"failed"`)
			require.NotContains(t, lines[1], `"receipt"`)
		})
	}
}

func TestProxy_UpstreamDown(t *testing.T) {
	p, auditPath := testProxy(t, nil, nil)

	resp := testPost(t, p, testRequest(t, "tools/call", testLabel(t, testTerms, "notes", true)))

	require.Equal(t, http.StatusBadGateway, resp.Code)
	require.JSONEq(t,
		`{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the server behind gave no answer"}}`,
		resp.Body.String())
	lines := strings.Split(strings.TrimSpace(testRead(t, auditPath)), "\n")
	require.Len(t, lines, 2)
	require.Contains(t, lines[1], `"outcome":"failed"`)
}

func TestStore(t *testing.T) {
	numbered := func(n int) *terms.Terms {
		parsed, err := terms.Parse(fmt.Appendf(nil,
			`{"version":"1.1","rules":[{"context_scope":"scope-%d","conditions":{}}]}`, n))
		require.NoError(t, err)

		return parsed
	}
	held := newStore(2)
	first, second, third := numbered(1), numbered(2), numbered(3)

	held.put(first)
	held.put(second)
	held.put(first)
	got, ok := held.get(first.Hash())
	require.True(t, ok)
	require.Same(t, first, got)

	held.put(third)
	_, ok = held.get(first.Hash())
	require.False(t, ok, "the terms held longest make way")
	_, ok = held.get(second.Hash())
	require.True(t, ok)
	_, ok = held.get(third.Hash())
	require.True(t, ok)
}

// testLabel returns the terms label for the terms written and the scope, with the test nonce and commitment.
// The label includes written when withTerms is true.
func testLabel(t *testing.T, written string, scope string, withTerms bool) string {
	t.Helper()

	label := `{"terms_hash":"` + testTermsHash(t, written) + `","context_scope":"` + scope + `","nonce":"` +
		testNonce + `","commitment":"` + testCommitment + `"`
	if withTerms {
		label += `,"terms":` + written
	}

	return label + "}"
}

// testPost sends body to p as an MCP client request and returns the response.
func testPost(t *testing.T, p *Proxy, body string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept-Encoding", "br")
	resp := httptest.NewRecorder()
	p.ServeHTTP(resp, req)

	return resp
}

// testProxy returns a proxy in front of upstream and the path of its audit record.
// The proxy requires terms, uses the test time and gives every request the test request ID.
// A nil upstream is a server that cannot be reached.
func testProxy(t *testing.T, upstream http.HandlerFunc, change func(*Config)) (*Proxy, string) {
	t.Helper()

	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	if upstream == nil {
		server.Close()
	}
	address, err := url.Parse(server.URL)
	require.NoError(t, err)

	auditPath := filepath.Join(t.TempDir(), "audit.jsonl")
	log, err := audit.Open(auditPath)
	require.NoError(t, err)
	t.Cleanup(func() { _ = log.Close() })

	config := Config{
		Audit:         log,
		Key:           testKey,
		TermsRequired: true,
		Tolerance:     testTolerance(t),
		Upstream:      address,
	}
	if change != nil {
		change(&config)
	}
	p, err := New(config)
	require.NoError(t, err)
	p.newID = func() string { return testRequestID }
	p.now = func() time.Time { return time.Date(2026, time.November, 17, 9, 30, 0, 0, time.UTC) }

	return p, auditPath
}

// testRead returns the content of the file at path.
func testRead(t *testing.T, path string) string {
	t.Helper()

	content, err := os.ReadFile(path)
	require.NoError(t, err)

	return string(content)
}

// testReceipt returns, as JSON, the receipt the test proxy signs for a request made under testTerms.
func testReceipt(t *testing.T) string {
	t.Helper()

	statement := receipt.Statement{
		Conditions: testConditions,
		RequestID:  testRequestID,
		ServedAt:   time.Date(2026, time.November, 17, 9, 30, 0, 0, time.UTC),
	}
	parsed, err := terms.Parse([]byte(testTerms))
	require.NoError(t, err)
	statement.TermsHash = parsed.Hash()
	_, err = hex.Decode(statement.Nonce[:], []byte(testNonce))
	require.NoError(t, err)
	_, err = hex.Decode(statement.Commitment[:], []byte(testCommitment))
	require.NoError(t, err)

	signed, err := receipt.Sign(testKey, statement)
	require.NoError(t, err)
	encoded, err := json.Marshal(signed)
	require.NoError(t, err)

	return string(encoded)
}

// testRequest returns a request with ID 7 for method.
// Its client lists the terms extension and sends label as its terms label.
func testRequest(t *testing.T, method string, label string) string {
	t.Helper()

	return `{"jsonrpc":"2.0","id":7,"method":"` + method + `","params":{"name":"echo","_meta":{` + testCapabilities +
		`,"earth.freehold/terms":` + label + `}}}`
}

// testTermsHash returns the hash of the terms written, in lowercase hex.
func testTermsHash(t *testing.T, written string) string {
	t.Helper()

	parsed, err := terms.Parse([]byte(written))
	require.NoError(t, err)
	hash := parsed.Hash()

	return hex.EncodeToString(hash[:])
}

// testTolerance returns the tolerance of an operator that serves under any terms its custody level allows.
func testTolerance(t *testing.T) spal.Tolerance {
	t.Helper()

	return spal.Tolerance{
		Custody:     spal.CustodyFederatedOperator,
		Training:    spal.TrainingForbidden,
		Aggregation: spal.AggregationForbidden,
		Resale:      spal.ResaleForbidden,
	}
}
