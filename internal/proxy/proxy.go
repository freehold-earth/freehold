package proxy

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"
	"uuid"

	"github.com/freehold-earth/freehold/internal/audit"
	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

const (
	// DefaultMaxBodyBytes is the default limit on the size of a request and of a single response message.
	DefaultMaxBodyBytes = 4 << 20

	// storedTerms is the maximum number of terms a proxy holds.
	storedTerms = 1024
)

// Recorder is an operator's audit record of requests made under terms.
type Recorder interface {
	// Record adds entry to the record and returns once the entry is stored.
	Record(entry audit.Entry) error
}

// Config is the configuration of a Proxy.
type Config struct {
	// Audit is the operator's audit record.
	// A request made under terms is forwarded only after it is recorded here.
	Audit Recorder

	// Key is the operator's signing key.
	// Receipts are signed with it, under the did:key identifier of its public key.
	Key ed25519.PrivateKey

	// Logger receives the proxy's error reports.
	// No request content is logged.
	// A nil Logger means the default logger.
	Logger *slog.Logger

	// MaxBodyBytes is the limit on the size of a request and of a single response message.
	// Zero means DefaultMaxBodyBytes.
	MaxBodyBytes int64

	// TermsRequired is true when the operator serves no data-carrying request made without terms.
	TermsRequired bool

	// Tolerance is the strictest terms the operator serves under.
	Tolerance spal.Tolerance

	// Upstream is the http or https URL of the MCP server that requests are forwarded to.
	// A request is forwarded to the same path under it.
	// NOTE: http does not encrypt the end-user's data, so it should be used only for a server on the same machine.
	Upstream *url.URL
}

// Proxy is an http.Handler that applies the terms extension in front of an operator's MCP server.
// It is safe for concurrent use.
// It limits the size of a request but not the time a request takes to arrive.
// A request cut off by the HTTP server's read timeout is answered with status 408.
// NOTE: A Proxy must be created with New, and its HTTP server should set a read timeout.
type Proxy struct {
	// advertised is the operator's advertisement for a discovery result.
	advertised advertisement

	// audit is the operator's audit record.
	audit Recorder

	// forward forwards a request to the upstream server.
	forward *httputil.ReverseProxy

	// key is the operator's signing key.
	key ed25519.PrivateKey

	// logger receives the proxy's error reports.
	logger *slog.Logger

	// maxBody is the limit on the size of a request and of a single response message.
	maxBody int64

	// newID returns a new request ID.
	newID func() string

	// now returns the current time.
	now func() time.Time

	// required is true when the operator serves no data-carrying request made without terms.
	required bool

	// terms holds the terms the proxy has been sent.
	terms *store

	// tolerance is the strictest terms the operator serves under.
	tolerance spal.Tolerance
}

// bodiless lists the HTTP methods, other than POST, that the proxy forwards.
// A request with one of them is forwarded only when it has no body.
// The methods are in the order the Allow header lists them.
var bodiless = []string{http.MethodGet, http.MethodHead, http.MethodDelete, http.MethodOptions}

// exchangeKey is the context key for the exchange of a request.
type exchangeKey struct{}

// New returns a Proxy for config.
// It returns ErrConfig if the upstream is not an http or https URL, the key is not an Ed25519 private key,
// the tolerance holds a value S-PAL does not allow, there is no audit record, or the largest body is below zero.
func New(config Config) (*Proxy, error) {
	if config.Upstream == nil || config.Upstream.Host == "" ||
		(config.Upstream.Scheme != "http" && config.Upstream.Scheme != "https") {
		return nil, fmt.Errorf("%w: the upstream is not an http or https URL", ErrConfig)
	}
	if len(config.Key) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("%w: the key is not an Ed25519 private key", ErrConfig)
	}
	// The assertion is safe because the key length is checked above.
	operatorDID, err := didkey.FromPublicKey(config.Key.Public().(ed25519.PublicKey))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrConfig, err)
	}
	if err := config.Tolerance.Validate(); err != nil {
		return nil, fmt.Errorf("%w: tolerance: %w", ErrConfig, err)
	}
	if config.Audit == nil {
		return nil, fmt.Errorf("%w: there is no audit record", ErrConfig)
	}
	if config.MaxBodyBytes < 0 {
		return nil, fmt.Errorf("%w: the largest body is below zero", ErrConfig)
	}

	p := &Proxy{
		advertised: advertisement{
			OperatorDID:         operatorDID,
			Custody:             config.Tolerance.Custody,
			RetentionMinSeconds: config.Tolerance.RetentionMinSeconds,
			Training:            config.Tolerance.Training,
			Aggregation:         config.Tolerance.Aggregation,
			Resale:              config.Tolerance.Resale,
			Terms:               termsOptional,
		},
		audit:     config.Audit,
		key:       config.Key,
		logger:    config.Logger,
		maxBody:   config.MaxBodyBytes,
		newID:     func() string { return uuid.New().String() },
		now:       time.Now,
		required:  config.TermsRequired,
		terms:     newStore(storedTerms),
		tolerance: config.Tolerance,
	}
	if p.required {
		p.advertised.Terms = termsRequired
	}
	if p.logger == nil {
		p.logger = slog.Default()
	}
	if p.maxBody == 0 {
		p.maxBody = DefaultMaxBodyBytes
	}

	upstream := *config.Upstream
	p.forward = &httputil.ReverseProxy{
		Rewrite: func(out *httputil.ProxyRequest) {
			out.SetURL(&upstream)
			out.SetXForwarded()
			// Removing the header makes the transport decompress the response, so the proxy can read it as JSON.
			out.Out.Header.Del("Accept-Encoding")
		},
		ModifyResponse: p.answer,
		ErrorHandler:   p.unanswered,
		ErrorLog:       slog.NewLogLogger(p.logger.Handler(), slog.LevelError),
	}

	return p, nil
}

// ServeHTTP refuses the request, or forwards it to the upstream server and writes that server's response.
// The response to a request made under terms carries a receipt.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The proxy cannot read an upgraded connection, and MCP does not use one.
	if r.Header.Get("Upgrade") != "" {
		http.Error(w, "this server does not change protocol", http.StatusBadRequest)
		return
	}

	// MCP sends every message as a POST.
	// Another method is forwarded only without a body, because the proxy does not check a body it has not read.
	if r.Method != http.MethodPost {
		if !slices.Contains(bodiless, r.Method) {
			w.Header().Set("Allow", strings.Join(append([]string{http.MethodPost}, bodiless...), ", "))
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.ContentLength != 0 {
			http.Error(w, "this method carries no body", http.StatusBadRequest)
			return
		}
		p.forward.ServeHTTP(w, r)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, p.maxBody))
	if err != nil {
		status := http.StatusBadRequest
		if _, tooLarge := errors.AsType[*http.MaxBytesError](err); tooLarge {
			status = http.StatusRequestEntityTooLarge
		} else if errors.Is(err, os.ErrDeadlineExceeded) {
			status = http.StatusRequestTimeout
		}
		p.writeError(w, status, nil, rpcError{Code: codeInvalidRequest, Message: "the request could not be read"})
		return
	}

	req, err := parseRequest(body)
	if err != nil {
		// The parse error can quote the request, so it is not returned.
		p.writeError(w, http.StatusBadRequest, nil, rpcError{Code: codeParse, Message: "not a JSON-RPC request"})
		return
	}

	// MCP requires a server that reads the body to refuse a request whose method header disagrees with it.
	if named := r.Header.Get(headerMethod); named != "" && named != req.method {
		p.writeError(w, http.StatusBadRequest, req.id, rpcError{
			Code:    codeHeaderMismatch,
			Message: "Header mismatch: " + headerMethod + " does not match the method in the body",
		})
		return
	}

	ex := &exchange{proxy: p, id: req.id, method: req.method}
	listed := req.listsExtension()
	said, labeled, saidErr := req.said()

	// Only the proxy sets the commitment, so one sent by the client is removed.
	_, claimed := req.meta[keyCommitment]
	delete(req.meta, keyCommitment)

	switch {
	case listed && labeled && saidErr != nil:
		p.logger.DebugContext(r.Context(), "refusing terms that are not well formed", "error", saidErr)
		p.refuse(w, ex, &terms.Refusal{Reason: terms.ReasonTermsMalformed}, nil)
		return
	case listed && labeled:
		if !p.accept(w, ex, said) {
			return
		}
		if body, err = req.withCommitment(ex.committed()); err != nil {
			p.unencoded(w, ex, err)
			return
		}
	case p.required && slices.Contains(dataCarrying, req.method):
		p.turnAway(w, ex, listed)
		return
	case claimed:
		if body, err = req.encode(); err != nil {
			p.unencoded(w, ex, err)
			return
		}
	}

	out := r.Clone(context.WithValue(r.Context(), exchangeKey{}, ex))
	out.Body = io.NopCloser(bytes.NewReader(body))
	out.ContentLength = int64(len(body))
	p.forward.ServeHTTP(w, out)
}

// accept runs the extension's checks on a request made under terms and reports whether it may be forwarded.
// It records a request that may be forwarded as accepted and sets the operator's commitment on ex.
// It answers a request that may not be forwarded with a refusal, or with an error when recording fails.
func (p *Proxy) accept(w http.ResponseWriter, ex *exchange, said sent) bool {
	ex.said = &said

	held, refused := p.termsFor(said)
	if refused != nil {
		p.refuse(w, ex, refused, &said)
		return false
	}

	conditions, err := held.Commitment(said.scope, p.tolerance)
	if refused, ok := errors.AsType[*terms.Refusal](err); ok {
		p.refuse(w, ex, refused, &said)
		return false
	}
	if err != nil {
		p.logger.Error("deciding a request", "error", err)
		p.writeError(w, http.StatusInternalServerError, ex.id, rpcError{Code: codeInternal, Message: "internal error"})
		return false
	}

	ex.conditions = &conditions
	ex.requestID = p.newID()
	if err := p.audit.Record(ex.entry(audit.OutcomeAccepted)); err != nil {
		// The operator does not serve a request that is not in its audit record.
		p.logger.Error("recording an accepted request", "error", err)
		ex.conditions = nil
		p.writeError(w, http.StatusInternalServerError, ex.id, rpcError{Code: codeInternal, Message: "internal error"})
		return false
	}

	return true
}

// answer rewrites the upstream response for its exchange.
// It adds the operator's advertisement to a discovery result,
// and a receipt to the result of a request made under terms.
func (p *Proxy) answer(resp *http.Response) error {
	if resp.StatusCode == http.StatusSwitchingProtocols {
		return errors.New("the server changed protocol")
	}

	ex, ok := resp.Request.Context().Value(exchangeKey{}).(*exchange)
	if !ok || !ex.rewrites() {
		return nil
	}

	mediaType := resp.Header.Get("Content-Type")
	switch {
	case hasMediaType(mediaType, "text/event-stream"):
		resp.Body = newEventRewriter(resp.Body, ex, p.maxBody)
		resp.Header.Del("Content-Length")
		resp.ContentLength = -1
	case hasMediaType(mediaType, "application/json"):
		message, err := io.ReadAll(io.LimitReader(resp.Body, p.maxBody+1))
		err = errors.Join(err, resp.Body.Close())
		if err == nil && int64(len(message)) > p.maxBody {
			err = errors.New("the server's response is larger than the proxy reads")
		}
		if err == nil {
			message, err = ex.rewrite(message)
		}
		// A message that is not a response leaves an accepted request unanswered, which is recorded as failed.
		ex.finish(audit.OutcomeFailed, nil)
		if err != nil {
			return err
		}
		resp.Body = io.NopCloser(bytes.NewReader(message))
		resp.ContentLength = int64(len(message))
		resp.Header.Set("Content-Length", fmt.Sprint(len(message)))
	default:
		// The response is not an MCP response, so no result can carry a receipt.
		ex.finish(audit.OutcomeFailed, nil)
	}

	return nil
}

// hasMediaType reports whether header, a Content-Type value, names mediaType with any parameters.
func hasMediaType(header string, mediaType string) bool {
	named, _, err := mime.ParseMediaType(header)

	return err == nil && named == mediaType
}

// refuse answers a request with a refusal and records the refusal.
// said is the terms label of the request, or nil when the request has no well-formed label.
func (p *Proxy) refuse(w http.ResponseWriter, ex *exchange, refused *terms.Refusal, said *sent) {
	// A condition that is not understood has a name taken from the terms, so the name is truncated.
	condition := refused.Condition
	if len(condition) > maxNameBytes {
		condition = strings.ToValidUTF8(condition[:maxNameBytes], "")
	}
	entry := audit.Entry{
		Time:      p.now().UTC(),
		Outcome:   audit.OutcomeRefused,
		Method:    ex.method,
		Reason:    refused.Reason,
		Condition: condition,
	}
	data := refusal{Reason: refused.Reason, Condition: condition}
	if said != nil {
		entry.TermsHash = hex.EncodeToString(said.termsHash[:])
		entry.Nonce = hex.EncodeToString(said.nonce[:])
		entry.ContextScope = said.scope
		// Malformed terms are not terms, so their refusal carries no terms hash.
		if refused.Reason != terms.ReasonTermsMalformed {
			data.TermsHash = entry.TermsHash
		}
	}
	if err := p.audit.Record(entry); err != nil {
		// The request is refused even when the refusal cannot be recorded, because nothing is forwarded.
		p.logger.Error("recording a refusal", "error", err)
	}

	message := "terms refused: " + string(refused.Reason)
	if data.Condition != "" {
		message += ": " + data.Condition
	}
	p.writeError(w, http.StatusOK, ex.id, rpcError{
		Code:    codeRefused,
		Message: message,
		Data:    map[string]refusal{keyRefusal: data},
	})
}

// termsFor returns the terms a request is made under.
// They are the terms the request sent, when their hash matches the hash it names, or the stored terms for that hash.
// It returns a refusal when it has no terms to return.
func (p *Proxy) termsFor(said sent) (*terms.Terms, *terms.Refusal) {
	if said.terms == nil {
		held, ok := p.terms.get(said.termsHash)
		if !ok {
			return nil, &terms.Refusal{Reason: terms.ReasonTermsUnknown}
		}

		return held, nil
	}

	given, err := terms.Parse(said.terms)
	if err != nil {
		refused, ok := errors.AsType[*terms.Refusal](err)
		if !ok {
			refused = &terms.Refusal{Reason: terms.ReasonTermsMalformed}
		}

		return nil, refused
	}
	if given.Hash() != said.termsHash {
		return nil, &terms.Refusal{Reason: terms.ReasonTermsMismatch}
	}
	p.terms.put(given)

	return given, nil
}

// turnAway answers a data-carrying request made without terms when the operator requires terms.
// A client that lists the extension gets a refusal, and any other client gets the MCP missing-capability error.
func (p *Proxy) turnAway(w http.ResponseWriter, ex *exchange, listed bool) {
	if listed {
		p.refuse(w, ex, &terms.Refusal{Reason: terms.ReasonTermsRequired}, nil)
		return
	}

	p.writeError(w, http.StatusBadRequest, ex.id, rpcError{
		Code:    codeMissingCapability,
		Message: "this server serves this request only under the terms extension " + extensionID,
		Data: map[string]any{
			"requiredCapabilities": map[string]any{
				memberExtensions: map[string]any{extensionID: struct{}{}},
			},
		},
	})
}

// unanswered answers a request when the upstream server gave no usable response.
func (p *Proxy) unanswered(w http.ResponseWriter, r *http.Request, err error) {
	p.logger.ErrorContext(r.Context(), "passing a request on", "error", err)

	var id []byte
	if ex, ok := r.Context().Value(exchangeKey{}).(*exchange); ok {
		ex.finish(audit.OutcomeFailed, nil)
		id = ex.id
	}
	p.writeError(
		w,
		http.StatusBadGateway,
		id,
		rpcError{Code: codeInternal, Message: "the server behind gave no answer"},
	)
}

// unencoded answers a request that could not be encoded for forwarding, and ends its exchange.
func (p *Proxy) unencoded(w http.ResponseWriter, ex *exchange, err error) {
	p.logger.Error("encoding a request to pass on", "error", err)
	ex.finish(audit.OutcomeFailed, nil)
	p.writeError(w, http.StatusInternalServerError, ex.id, rpcError{Code: codeInternal, Message: "internal error"})
}
