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
	// DefaultMaxBodyBytes is the largest request, and the largest single response message, a proxy reads when its
	// configuration does not say.
	DefaultMaxBodyBytes = 4 << 20

	// storedTerms is the most terms a proxy holds at once.
	storedTerms = 1024
)

// Recorder is an operator's record of the requests it takes under terms.
type Recorder interface {
	// Record adds entry to the record, and returns once it is kept.
	Record(entry audit.Entry) error
}

// Config is what a proxy is made from.
type Config struct {
	// Upstream is the address of the MCP server the proxy stands in front of: an http or https URL. A request is
	// passed on to the same path under it. Over http, what an end-user sent travels to the server in the clear,
	// which suits a server on the same machine and no other.
	Upstream *url.URL

	// Key is the operator's signing key. Receipts are signed with it, as the did:key identifier of its public half.
	Key ed25519.PrivateKey

	// Tolerance is the strictest terms the operator serves under.
	Tolerance spal.Tolerance

	// TermsRequired is whether the operator serves no data-carrying request made without terms.
	TermsRequired bool

	// Audit is the operator's record. Nothing made under terms is passed on unless it is recorded here first.
	Audit Recorder

	// Logger is where the proxy reports what goes wrong. Nothing of a request's content is logged. The default
	// logger is used where it is nil.
	Logger *slog.Logger

	// MaxBodyBytes is the largest request, and the largest single response message, the proxy reads.
	// DefaultMaxBodyBytes is used where it is zero.
	MaxBodyBytes int64
}

// Proxy answers for an operator in front of its MCP server. It is an http.Handler, safe for use by several
// goroutines at once.
//
// A Proxy bounds how large a request may be. How long a request may take to arrive is for the server it is mounted
// on to bound, with http.Server's ReadTimeout: a request cut off by that limit is answered with 408.
//
// A Proxy comes from New.
type Proxy struct {
	// advertised is what the operator says of itself in a discovery result.
	advertised advertisement

	// audit is the operator's record.
	audit Recorder

	// forward passes a request on to the server behind.
	forward *httputil.ReverseProxy

	// key is the operator's signing key.
	key ed25519.PrivateKey

	// logger is where the proxy reports what goes wrong.
	logger *slog.Logger

	// maxBody is the largest request, and the largest single response message, the proxy reads.
	maxBody int64

	// newID returns a new handle for a request.
	newID func() string

	// now returns the time.
	now func() time.Time

	// required is whether the operator serves no data-carrying request made without terms.
	required bool

	// terms are the terms the proxy has been sent.
	terms *store

	// tolerance is the strictest terms the operator serves under.
	tolerance spal.Tolerance
}

// bodiless are the HTTP methods, other than POST, that the proxy passes on. None of them carries a request.
var bodiless = []string{http.MethodGet, http.MethodHead, http.MethodDelete, http.MethodOptions}

// exchangeKey is the key under which a request's context holds its exchange.
type exchangeKey struct{}

// New returns a proxy for the operator that config describes.
//
// It returns ErrConfig if the upstream is not an http or https URL, the key is not an Ed25519 private key, the
// tolerance holds a value S-PAL does not allow, there is no audit record, or the largest body is below zero.
func New(config Config) (*Proxy, error) {
	if config.Upstream == nil || config.Upstream.Host == "" ||
		(config.Upstream.Scheme != "http" && config.Upstream.Scheme != "https") {
		return nil, fmt.Errorf("%w: the upstream is not an http or https URL", ErrConfig)
	}
	if len(config.Key) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("%w: the key is not an Ed25519 private key", ErrConfig)
	}
	// The assertion is safe: Public returns an ed25519.PublicKey for a key of the right length, checked above.
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
			// The transport then asks for compression on its own account and undoes it, so that a response
			// arrives as the JSON it is and can be read.
			out.Out.Header.Del("Accept-Encoding")
		},
		ModifyResponse: p.answer,
		ErrorHandler:   p.unanswered,
		ErrorLog:       slog.NewLogLogger(p.logger.Handler(), slog.LevelError),
	}

	return p, nil
}

// ServeHTTP answers one request: it refuses it, or passes it on to the server behind and returns that server's
// answer, with a receipt where the request was made under terms.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A connection that changes protocol stops being HTTP, and what then passes along it is nothing the proxy
	// reads. MCP has no use for one.
	if r.Header.Get("Upgrade") != "" {
		http.Error(w, "this server does not change protocol", http.StatusBadRequest)
		return
	}

	// MCP sends every message as a POST. The other methods it knows carry nothing, and are the server's to answer
	// as long as they carry nothing: a body the proxy has not read is one it cannot vouch for.
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
		// What is wrong is not echoed: it would quote the request.
		p.writeError(w, http.StatusBadRequest, nil, rpcError{Code: codeParse, Message: "not a JSON-RPC request"})
		return
	}

	// MCP repeats the method in a header, for whatever routes on headers alone, and has a server that reads the body
	// refuse a request whose two accounts of itself differ.
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

	// Only the proxy says what the operator has committed to: a request does not get to say it for itself.
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

// accept makes the extension's checks of a request made under terms, and reports whether the request may be passed
// on. A request that may is recorded as accepted, and ex then holds what the operator has committed to for it. One
// that may not has been answered: with a refusal, or with an error where it could not be recorded.
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
		// A request the operator has no record of taking is one it does not take.
		p.logger.Error("recording an accepted request", "error", err)
		ex.conditions = nil
		p.writeError(w, http.StatusInternalServerError, ex.id, rpcError{Code: codeInternal, Message: "internal error"})
		return false
	}

	return true
}

// answer puts into the server's response what the proxy owes the client: the operator's tolerance in a discovery
// result, and a receipt in the result of a request made under terms.
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
		// A message that was no response leaves an accepted request unanswered, which is a failure too.
		ex.finish(audit.OutcomeFailed, nil)
		if err != nil {
			return err
		}
		resp.Body = io.NopCloser(bytes.NewReader(message))
		resp.ContentLength = int64(len(message))
		resp.Header.Set("Content-Length", fmt.Sprint(len(message)))
	default:
		// Not an MCP response, so there is no result to put a receipt in.
		ex.finish(audit.OutcomeFailed, nil)
	}

	return nil
}

// hasMediaType reports whether the content type header value names mediaType, whatever parameters follow it.
func hasMediaType(header string, mediaType string) bool {
	named, _, err := mime.ParseMediaType(header)

	return err == nil && named == mediaType
}

// refuse answers a request with a refusal and records it. said is what the request said of its terms, where that
// was well formed.
func (p *Proxy) refuse(w http.ResponseWriter, ex *exchange, refused *terms.Refusal, said *sent) {
	// The name of something not understood is whatever the terms called it, so it is kept to a length worth reading.
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
		// A refusal names the terms it is about. Terms that are malformed are not terms, so it names none.
		if refused.Reason != terms.ReasonTermsMalformed {
			data.TermsHash = entry.TermsHash
		}
	}
	if err := p.audit.Record(entry); err != nil {
		// The request is refused whether or not the refusal is recorded: nothing of it goes any further.
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

// termsFor returns the terms a request is made under: the ones it sent, once they are found to have the hash it
// names, or the ones held for that hash. It returns the refusal where there are none to return.
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

// turnAway answers a data-carrying request that an operator requiring terms was sent without any. A client that
// lists the extension is refused under it; one that does not is told, as MCP has it, which capability it lacks.
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

// unanswered answers a request the server behind gave no usable answer to.
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

// unencoded answers a request that could not be put back into JSON to pass on, which ends it.
func (p *Proxy) unencoded(w http.ResponseWriter, ex *exchange, err error) {
	p.logger.Error("encoding a request to pass on", "error", err)
	ex.finish(audit.OutcomeFailed, nil)
	p.writeError(w, http.StatusInternalServerError, ex.id, rpcError{Code: codeInternal, Message: "internal error"})
}
