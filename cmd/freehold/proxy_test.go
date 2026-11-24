package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
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

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/keyfile"
)

func TestIsLoopback(t *testing.T) {
	tests := map[string]struct {
		address string
		want    bool
	}{
		"a name":                    {address: "http://mcp.internal:9000", want: false},
		"a name that starts alike":  {address: "http://localhost.example.com", want: false},
		"an IPv4 loopback address":  {address: "http://127.0.0.1:9000", want: true},
		"an address on a network":   {address: "http://10.0.0.7:9000", want: false},
		"another IPv4 loopback":     {address: "http://127.8.0.1", want: true},
		"localhost":                 {address: "http://localhost:9000", want: true},
		"the IPv6 loopback address": {address: "http://[::1]:9000", want: true},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			address, err := url.Parse(tc.address)
			require.NoError(t, err)

			require.Equal(t, tc.want, isLoopback(address))
		})
	}
}

func TestProxyCmd(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if _, err := io.WriteString(w, `{"jsonrpc":"2.0","id":7,"result":{"capabilities":{"tools":{}}}}`); err != nil {
			t.Errorf("the upstream could not answer: %v", err)
		}
	}))
	t.Cleanup(upstream.Close)

	// The file gives its key and audit record as relative paths, and an upstream that the flag replaces.
	dir := t.TempDir()
	key, err := keyfile.Create(filepath.Join(dir, "operator.pem"))
	require.NoError(t, err)
	did, err := didkey.FromPublicKey(key.Public().(ed25519.PublicKey))
	require.NoError(t, err)
	config := filepath.Join(dir, "proxy.toml")
	require.NoError(t, os.WriteFile(config, []byte("listen = '127.0.0.1:0'\n"+
		"upstream = 'http://192.0.2.1:9000'\n"+
		"key_file = 'operator.pem'\n"+
		"audit_file = 'audit.jsonl'\n"+
		"terms = 'optional'\n"+
		testTolerance), 0o600))

	ctx, cancel := context.WithCancel(t.Context())
	out, outWriter := io.Pipe()
	var logged bytes.Buffer
	cmd := newRootCmd()
	cmd.SetOut(outWriter)
	cmd.SetErr(&logged)
	cmd.SetArgs([]string{"proxy", "--config", config, "--upstream", upstream.URL})
	var stoppedErr error
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		stoppedErr = cmd.ExecuteContext(ctx)
		// Closing the writer ends the read below when the command stops before it prints its address.
		// CloseWithError always returns nil.
		_ = outWriter.CloseWithError(stoppedErr)
	}()
	// The command must stop before the temporary directory is removed.
	t.Cleanup(func() {
		cancel()
		<-stopped
	})

	line, err := bufio.NewReader(out).ReadString('\n')
	require.NoError(t, err)
	address, found := strings.CutPrefix(line, "listening on ")
	require.True(t, found, line)
	address, found = strings.CutSuffix(address, " as "+did+"\n")
	require.True(t, found, line)

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"http://"+address+"/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"server/discover","params":{"_meta":{}}}`),
	)
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.JSONEq(t, `{"jsonrpc":"2.0","id":7,"result":{"capabilities":{"tools":{},"extensions":{`+
		`"earth.freehold/spal":{"operator_did":"`+did+`","custody":"federated_operator",`+
		`"retention_min_seconds":0,"training":"forbidden","aggregation":"forbidden","resale":"forbidden",`+
		`"terms":"optional"}}}}}`, string(body))

	cancel()
	<-stopped
	require.NoError(t, stoppedErr)
	require.Contains(t, logged.String(), "operator_did="+did)
	require.NotContains(t, logged.String(), "level=WARN")
	require.FileExists(t, filepath.Join(dir, "audit.jsonl"))
}

func TestProxyCmd_Refuses(t *testing.T) {
	dir := t.TempDir()
	config := filepath.Join(dir, "proxy.toml")
	require.NoError(t, os.WriteFile(config, []byte("listen = '127.0.0.1:0'\n"+
		"upstream = 'http://127.0.0.1:9000'\n"+
		"key_file = 'operator.pem'\n"+
		"audit_file = 'audit.jsonl'\n"+
		"terms = 'required'\n"+
		testTolerance), 0o600))
	_, err := keyfile.Create(filepath.Join(dir, "other.pem"))
	require.NoError(t, err)

	tests := map[string]struct {
		args    []string
		wantErr string
	}{
		"a configuration that is not there": {
			args: []string{"proxy", "--config", filepath.Join(dir, "missing.toml")},
			wantErr: "reading the configuration: open " + filepath.Join(dir, "missing.toml") +
				": no such file or directory",
		},
		"a flag that makes the configuration unusable": {
			args:    []string{"proxy", "--config", config, "--upstream", "ftp://127.0.0.1"},
			wantErr: "the configuration is not usable: upstream is not an http or https URL",
		},
		"a key file that is not there": {
			args: []string{"proxy", "--config", config},
			wantErr: "opening the key file: open " + filepath.Join(dir, "operator.pem") +
				": no such file or directory",
		},
		"an address that cannot be listened on": {
			args: []string{
				"proxy", "--config", config, "--key-file", filepath.Join(dir, "other.pem"), "--listen", "nowhere",
			},
			wantErr: "listening on nowhere: listen tcp: address nowhere: missing port in address",
		},
		"an argument": {
			args:    []string{"proxy", "--config", config, "extra"},
			wantErr: `unknown command "extra" for "freehold proxy"`,
		},
		"an audit record that cannot be opened": {
			args: []string{
				"proxy", "--config", config, "--key-file", filepath.Join(dir, "other.pem"), "--audit-file", dir,
			},
			wantErr: "opening the audit record: open " + dir + ": is a directory",
		},
		"no configuration named": {
			args:    []string{"proxy"},
			wantErr: "--config is not set",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			cmd := newRootCmd()
			cmd.SetOut(&out)
			cmd.SetErr(&out)
			cmd.SetArgs(tc.args)

			require.EqualError(t, cmd.ExecuteContext(t.Context()), tc.wantErr)
			require.Empty(t, out.String())
		})
	}
}

func TestServe(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		// stream is true when the request never finishes by itself.
		stream bool
	}{
		"with a stream still open": {stream: true},
		"with nothing in flight":   {stream: false},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			var listen net.ListenConfig
			listener, err := listen.Listen(t.Context(), "tcp", "127.0.0.1:0")
			require.NoError(t, err)
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				if tc.stream {
					// The headers are flushed at once, and the response ends only when the server closes it.
					_ = http.NewResponseController(w).Flush()
					<-r.Context().Done()
				}
			})}

			ctx, cancel := context.WithCancel(t.Context())
			var stoppedErr error
			stopped := make(chan struct{})
			go func() {
				defer close(stopped)
				stoppedErr = serve(ctx, server, listener, 50*time.Millisecond)
			}()
			t.Cleanup(func() {
				cancel()
				<-stopped
			})

			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listener.Addr().String(), nil)
			require.NoError(t, err)
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			t.Cleanup(func() { _ = resp.Body.Close() })
			require.Equal(t, http.StatusOK, resp.StatusCode)

			cancel()
			<-stopped
			require.NoError(t, stoppedErr)
		})
	}
}

func TestServe_AnswerOutlastsReadTimeout(t *testing.T) {
	t.Parallel()

	var listen net.ListenConfig
	listener, err := listen.Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	// The read timeout is far shorter than the time the response takes.
	server := &http.Server{
		ReadTimeout: 20 * time.Millisecond,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "first\n")
			_ = http.NewResponseController(w).Flush()
			select {
			case <-time.After(200 * time.Millisecond):
				_, _ = io.WriteString(w, "last\n")
			case <-r.Context().Done():
			}
		}),
	}

	ctx, cancel := context.WithCancel(t.Context())
	var stoppedErr error
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		stoppedErr = serve(ctx, server, listener, time.Second)
	}()
	t.Cleanup(func() {
		cancel()
		<-stopped
	})

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listener.Addr().String(), nil)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, "first\nlast\n", string(body))

	cancel()
	<-stopped
	require.NoError(t, stoppedErr)
}

func TestServe_Fails(t *testing.T) {
	var listen net.ListenConfig
	listener, err := listen.Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	// A closed listener makes Serve fail.
	require.NoError(t, listener.Close())

	err = serve(t.Context(), &http.Server{}, listener, time.Second)
	require.ErrorContains(t, err, "serving: ")
	require.ErrorIs(t, err, net.ErrClosed)
}
