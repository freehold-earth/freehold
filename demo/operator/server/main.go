// Command server is an example of the MCP server an operator runs behind freehold proxy.
//
// The proxy checks an end-user's terms, signs the receipt and keeps the audit record. Keeping what the operator
// thereby committed to is left to the server behind, and this server shows where that server learns what it is: on
// every call the proxy passes on under terms, in _meta["earth.freehold/commitment"].
//
// The server has one tool, echo, which answers with the text it was sent and with the commitment the call came
// under. It keeps nothing it is sent, and so keeps every commitment. A server that stores, logs or learns from what
// it is sent has to hold each of those to the commitment it reads here.
package main

import (
	"context"
	"encoding/json/v2"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	// commitmentKey is the name, in a request's _meta, under which the proxy says what the operator has committed to.
	commitmentKey = "earth.freehold/commitment"

	// readHeaderTimeout is how long a client may take to send the headers of a request.
	readHeaderTimeout = 10 * time.Second

	// shutdownGrace is how long calls in flight are given to finish once the server is told to stop.
	shutdownGrace = 5 * time.Second
)

// commitment is what the operator has committed to for one request, as the proxy hands it on.
//
// It is the operator's word only where nothing but the proxy can reach the server: whatever else can call the
// server can write one of its own.
type commitment struct {
	// RequestID is the operator's handle for the request, the one on its receipt and its audit lines.
	RequestID string `json:"request_id"`

	// TermsHash is the hash of the terms the request was made under, in lowercase hex.
	TermsHash string `json:"terms_hash"`

	// ContextScope is the scope of the data the request concerns.
	ContextScope string `json:"context_scope"`

	// Custody is the custody level the operator serves the request at.
	Custody string `json:"custody"`

	// RetentionSeconds is the longest the operator may keep what the request sent it.
	RetentionSeconds uint64 `json:"retention_seconds"`

	// Training is what the operator may do by way of training on what it was sent.
	Training string `json:"training"`

	// Aggregation is what the operator may do by way of aggregating what it was sent.
	Aggregation string `json:"aggregation"`

	// Resale is what the operator may do by way of selling on what it was sent.
	Resale string `json:"resale"`
}

// echoInput is what the echo tool is called with.
type echoInput struct {
	// Text is the text to answer with.
	Text string `json:"text" jsonschema:"the text to answer with"`
}

// commitmentIn returns the commitment a request's metadata carries, and whether it carries one. A request that
// carries none was not made under terms.
//
// It returns an error for a commitment that cannot be read or that names no request.
func commitmentIn(meta mcp.Meta) (commitment, bool, error) {
	handed, found := meta[commitmentKey]
	if !found {
		return commitment{}, false, nil
	}

	// The metadata arrives as whatever JSON it was, so it is written back out and read into the type.
	written, err := json.Marshal(handed)
	if err != nil {
		return commitment{}, false, fmt.Errorf("reading the commitment: %w", err)
	}
	var committed commitment
	if err := json.Unmarshal(written, &committed); err != nil {
		return commitment{}, false, fmt.Errorf("reading the commitment: %w", err)
	}
	if committed.RequestID == "" {
		return commitment{}, false, errors.New("reading the commitment: it names no request")
	}

	return committed, true, nil
}

// echo answers a call with the text it was sent, and with what the operator has committed to for the call.
//
// It returns an error for a commitment it cannot read: a server that cannot tell what it is bound by must not go on
// as if it were bound by nothing.
func echo(_ context.Context, req *mcp.CallToolRequest, input echoInput) (*mcp.CallToolResult, any, error) {
	committed, underTerms, err := commitmentIn(req.Params.Meta)
	if err != nil {
		return nil, nil, err
	}

	bound := "This call was not made under terms, so the operator has committed to nothing for it."
	if underTerms {
		bound = fmt.Sprintf(
			"Request %s, for %s, was made under terms. The operator has committed to keep what it was sent for "+
				"no longer than %d seconds, with training %s, aggregation %s and resale %s.",
			committed.RequestID,
			committed.ContextScope,
			committed.RetentionSeconds,
			committed.Training,
			committed.Aggregation,
			committed.Resale,
		)
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: input.Text}, &mcp.TextContent{Text: bound}},
	}, nil, nil
}

// main runs the server until it is interrupted or told to terminate.
func main() {
	listen := flag.String("listen", "127.0.0.1:9000", "the address to listen on")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// The first signal is the only one waited on: a second ends the process at once.
	context.AfterFunc(ctx, stop)
	err := run(ctx, *listen)
	stop()
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

// newHandler returns the server as an HTTP handler. It holds nothing between requests.
func newHandler() http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "freehold-example", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "echo",
		Description: "Answer with the text sent, and with what the operator has committed to for the call.",
	}, echo)

	return mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true},
	)
}

// run serves on the address listen until ctx is done. It then takes no new calls, gives those in flight
// shutdownGrace to finish, and closes whatever is still open.
func run(ctx context.Context, listen string) error {
	var config net.ListenConfig
	listener, err := config.Listen(ctx, "tcp", listen)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", listen, err)
	}
	server := &http.Server{Handler: newHandler(), ReadHeaderTimeout: readHeaderTimeout}
	fmt.Printf("listening on %s\n", listener.Addr())

	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()

	select {
	case err := <-stopped:
		return fmt.Errorf("serving: %w", err)
	case <-ctx.Done():
	}

	finishing, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownGrace)
	defer cancel()
	if err := server.Shutdown(finishing); err != nil {
		if !errors.Is(err, context.DeadlineExceeded) {
			return errors.Join(fmt.Errorf("stopping: %w", err), server.Close())
		}
		// The time to finish ran out, so what is still open is closed.
		if err := server.Close(); err != nil {
			return fmt.Errorf("stopping: %w", err)
		}
	}

	return nil
}
