package main

import (
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"
)

func TestEcho(t *testing.T) {
	tests := map[string]struct {
		meta mcp.Meta
		want string
	}{
		"a call made without terms": {
			meta: mcp.Meta{"com.example/other": "x"},
			want: "This call was not made under terms, so the operator has committed to nothing for it.",
		},
		"a call the proxy passed on under terms": {
			meta: mcp.Meta{commitmentKey: map[string]any{
				"aggregation":       "forbidden",
				"context_scope":     "notes/2026",
				"custody":           "federated_operator",
				"request_id":        "0195c1f2-5c1e-7a52-9d2f-3f6f6f1f7a10",
				"resale":            "forbidden",
				"retention_seconds": 3600,
				"terms_hash":        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"training":          "forbidden",
			}},
			want: "Request 0195c1f2-5c1e-7a52-9d2f-3f6f6f1f7a10, for notes/2026, was made under terms. " +
				"The operator has committed to keep what it was sent for no longer than 3600 seconds, " +
				"with training forbidden, aggregation forbidden and resale forbidden.",
		},
		"a call with no metadata": {
			want: "This call was not made under terms, so the operator has committed to nothing for it.",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			result, _, err := echo(
				t.Context(),
				&mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Meta: tc.meta, Name: "echo"}},
				echoInput{Text: "hi"},
			)
			require.NoError(t, err)
			require.Len(t, result.Content, 2)
			require.Equal(t, "hi", result.Content[0].(*mcp.TextContent).Text)
			require.Equal(t, tc.want, result.Content[1].(*mcp.TextContent).Text)
		})
	}
}

func TestEcho_CommitmentUnreadable(t *testing.T) {
	tests := map[string]struct {
		handed  any
		wantErr string
	}{
		"a commitment that is not an object": {
			handed:  "kept forever",
			wantErr: "reading the commitment: ",
		},
		"a commitment that is null": {
			handed:  nil,
			wantErr: "reading the commitment: it names no request",
		},
		"a commitment that names no request": {
			handed:  map[string]any{"retention_seconds": 3600},
			wantErr: "reading the commitment: it names no request",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			_, _, err := echo(
				t.Context(),
				&mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Meta: mcp.Meta{commitmentKey: tc.handed}}},
				echoInput{Text: "hi"},
			)
			require.ErrorContains(t, err, tc.wantErr)
		})
	}
}

func TestHandler(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(newHandler())
	t.Cleanup(server.Close)

	client := mcp.NewClient(&mcp.Implementation{Name: "agent", Version: "1.0.0"}, nil)
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: server.URL}, nil)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, session.Close()) })

	// The commitment travels in the call's metadata and must reach the tool.
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Meta: mcp.Meta{commitmentKey: map[string]any{
			"aggregation":       "forbidden",
			"context_scope":     "notes",
			"request_id":        "req-1",
			"resale":            "forbidden",
			"retention_seconds": 60,
			"training":          "forbidden",
		}},
		Name:      "echo",
		Arguments: echoInput{Text: "hi"},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Len(t, result.Content, 2)
	require.Equal(t, "hi", result.Content[0].(*mcp.TextContent).Text)
	require.Equal(t, "Request req-1, for notes, was made under terms. The operator has committed to keep what it "+
		"was sent for no longer than 60 seconds, with training forbidden, aggregation forbidden and resale forbidden.",
		result.Content[1].(*mcp.TextContent).Text)
}
