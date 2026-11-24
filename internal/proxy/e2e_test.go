package proxy

import (
	"context"
	"encoding/json/v2"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"
)

// testEchoInput is the input of the test server's tool.
type testEchoInput struct {
	// Text is the text the tool returns.
	Text string `json:"text"`
}

// TestProxy_BetweenAClientAndAServer runs the proxy between the client and the server of the MCP SDK.
// The SDK is an independent implementation of MCP, so the test checks interoperability.
func TestProxy_BetweenAClientAndAServer(t *testing.T) {
	tests := map[string]bool{
		"a server that answers with JSON":               true,
		"a server that answers with a stream of events": false,
	}

	for name, jsonResponse := range tests {
		t.Run(name, func(t *testing.T) {
			// The tool returns the commitment it received, so the test can check it.
			server := mcp.NewServer(&mcp.Implementation{Name: "notes", Version: "1.0.0"}, nil)
			mcp.AddTool(server, &mcp.Tool{Name: "echo"}, func(
				_ context.Context, req *mcp.CallToolRequest, input testEchoInput,
			) (*mcp.CallToolResult, any, error) {
				if req.Params.Meta[keyCommitment] == nil {
					t.Error("a call reached the server with no commitment")
				}
				handed, err := json.Marshal(req.Params.Meta[keyCommitment])
				if err != nil {
					return nil, nil, err
				}

				return &mcp.CallToolResult{
					Content: []mcp.Content{&mcp.TextContent{Text: input.Text}, &mcp.TextContent{Text: string(handed)}},
				}, nil, nil
			})
			handler := mcp.NewStreamableHTTPHandler(
				func(*http.Request) *mcp.Server { return server },
				&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: jsonResponse},
			)

			p, _ := testProxy(t, handler.ServeHTTP, nil)
			front := httptest.NewServer(p)
			t.Cleanup(front.Close)

			client := mcp.NewClient(&mcp.Implementation{Name: "agent", Version: "1.0.0"}, &mcp.ClientOptions{
				Capabilities: &mcp.ClientCapabilities{Extensions: map[string]any{extensionID: map[string]any{}}},
			})
			session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: front.URL}, nil)
			require.NoError(t, err)
			t.Cleanup(func() { _ = session.Close() })

			// The client learns the operator's advertisement when it connects.
			advertised, err := json.Marshal(session.InitializeResult().Capabilities.Extensions[extensionID])
			require.NoError(t, err)
			want, err := json.Marshal(p.advertised)
			require.NoError(t, err)
			require.JSONEq(t, string(want), string(advertised))

			// A request that carries no data is served without terms.
			tools, err := session.ListTools(t.Context(), nil)
			require.NoError(t, err)
			require.Len(t, tools.Tools, 1)

			// A call without terms is refused and does not reach the server.
			_, err = session.CallTool(
				t.Context(),
				&mcp.CallToolParams{Name: "echo", Arguments: testEchoInput{Text: "hi"}},
			)
			refused, ok := errors.AsType[*jsonrpc.Error](err)
			require.True(t, ok, "want a JSON-RPC error, got %v", err)
			require.EqualValues(t, codeRefused, refused.Code)
			require.JSONEq(t, `{"earth.freehold/refusal":{"reason":"terms_required"}}`, string(refused.Data))

			// A call under terms is served.
			// The server receives the commitment and the result carries the receipt.
			var label map[string]any
			require.NoError(t, json.Unmarshal([]byte(testLabel(t, testTerms, "notes/2026", true)), &label))
			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
				Meta:      mcp.Meta{keyTerms: label},
				Name:      "echo",
				Arguments: testEchoInput{Text: "hi"},
			})
			require.NoError(t, err)
			require.Len(t, result.Content, 2)
			require.Equal(t, "hi", result.Content[0].(*mcp.TextContent).Text)
			require.JSONEq(t, `{"request_id":"req-1","terms_hash":"`+testTermsHash(t, testTerms)+
				`","context_scope":"notes/2026","custody":"federated_operator","retention_seconds":3600,`+
				`"training":"forbidden","aggregation":"forbidden","resale":"forbidden"}`,
				result.Content[1].(*mcp.TextContent).Text)

			signed, err := json.Marshal(result.Meta[keyReceipt])
			require.NoError(t, err)
			require.JSONEq(t, testReceipt(t), string(signed))
		})
	}
}

// TestProxy_BetweenAServerAndAClientWithoutTheExtension runs a client that lacks the extension,
// against an operator that requires terms.
func TestProxy_BetweenAServerAndAClientWithoutTheExtension(t *testing.T) {
	server := mcp.NewServer(&mcp.Implementation{Name: "notes", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "echo"}, func(
		context.Context, *mcp.CallToolRequest, testEchoInput,
	) (*mcp.CallToolResult, any, error) {
		t.Error("a call without terms reached the server")

		return &mcp.CallToolResult{}, nil, nil
	})
	handler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true},
	)

	p, _ := testProxy(t, handler.ServeHTTP, nil)
	front := httptest.NewServer(p)
	t.Cleanup(front.Close)

	client := mcp.NewClient(&mcp.Implementation{Name: "other", Version: "1.0.0"}, nil)
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: front.URL}, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	tools, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, tools.Tools, 1)

	_, err = session.CallTool(t.Context(), &mcp.CallToolParams{Name: "echo", Arguments: testEchoInput{Text: "hi"}})
	missing, ok := errors.AsType[*jsonrpc.Error](err)
	require.True(t, ok, "want a JSON-RPC error, got %v", err)
	require.EqualValues(t, codeMissingCapability, missing.Code)
	require.JSONEq(t, `{"requiredCapabilities":{"extensions":{"earth.freehold/spal":{}}}}`, string(missing.Data))
}
