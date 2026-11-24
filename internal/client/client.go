package client

import (
	"context"
	legacyjson "encoding/json"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/receipt"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
	"github.com/freehold-earth/freehold/internal/version"
)

// DefaultMaxResponseBytes is the default limit on the size of a response.
const DefaultMaxResponseBytes = 4 << 20

// Recorder is an end-user's record of the requests sent under terms, and of how each ended.
// NOTE: A Recorder must be safe for concurrent use.
type Recorder interface {
	// Record adds sent to the record and returns once sent is stored.
	Record(sent Sent) error

	// RecordOutcome adds outcome to the record as the end of the request sent under label.
	RecordOutcome(label receipt.Label, outcome Outcome) error
}

// Config is the configuration of a Session.
type Config struct {
	// AuditKey is the end-user's audit key, which keys the commitment to each request.
	// NOTE: It must hold at least receipt.AuditKeyMinBytes bytes.
	AuditKey []byte

	// Endpoint is the http or https URL of the operator's MCP server.
	// NOTE: http does not encrypt the end-user's data, so it should be used only for a server on the same machine.
	Endpoint string

	// HTTPClient makes the HTTP requests.
	// A nil HTTPClient means http.DefaultClient.
	// A Session follows no redirect, so the redirect policy of HTTPClient is not used.
	HTTPClient *http.Client

	// MaxResponseBytes is the limit on the size of a response.
	// Zero means DefaultMaxResponseBytes.
	MaxResponseBytes int64

	// Operator is the operator's decentralized identifier (DID).
	// Every receipt is verified against it, and a server that advertises another DID is not used.
	// NOTE: It must be a did:key that holds an Ed25519 key.
	Operator string

	// Record is the end-user's record.
	// A request is sent only after it is recorded here, and its outcome is recorded once it ends.
	Record Recorder

	// Terms is the end-user's terms, as a JSON object.
	Terms []byte
}

// ToolResult is the result of a tool call made under terms.
type ToolResult struct {
	// Receipt is the operator's receipt for the call.
	Receipt receipt.Receipt

	// Tool is the tool's result.
	Tool *mcp.CallToolResult
}

// Sent describes one request that is about to be sent to an operator.
// It holds none of the request's content.
type Sent struct {
	// Label is the label that the receipt for the request must carry.
	Label receipt.Label

	// Method is the MCP method of the request.
	Method string

	// Operator is the operator's DID.
	Operator string

	// Scope is the scope of the data the request carries.
	Scope string

	// Time is when the request was labeled.
	Time time.Time
}

// Session is a connection to one operator's MCP server, for requests made under one end-user's terms.
// It is safe for concurrent use.
// NOTE: A Session must be created with Connect, and should be closed with Close.
type Session struct {
	// auditKey is the end-user's audit key.
	auditKey []byte

	// operator is the operator's DID.
	operator string

	// record is the end-user's record.
	record Recorder

	// session is the MCP session.
	session *mcp.ClientSession

	// terms is the end-user's terms.
	terms *terms.Terms

	// tolerance is the tolerance the operator advertised.
	tolerance spal.Tolerance

	// written is the terms document as configured.
	written jsontext.Value
}

// toolCall is a tool call that is ready to label and send.
type toolCall struct {
	// params is the parameters of the call, without a terms label.
	params mcp.CallToolParams

	// request is the bytes that the commitment covers.
	request []byte

	// scope is the scope of the data the call carries.
	scope string
}

// Connect opens a session with the operator's server and reads the operator's tolerance.
// It sends none of the end-user's data.
// It returns ErrConfig when config is not usable, ErrExtension when the server does not advertise the extension,
// and ErrOperator when the server advertises an operator other than the configured one.
func Connect(ctx context.Context, config Config) (*Session, error) {
	if len(config.AuditKey) < receipt.AuditKeyMinBytes {
		return nil, fmt.Errorf("%w: the audit key is shorter than %d bytes", ErrConfig, receipt.AuditKeyMinBytes)
	}
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return nil, fmt.Errorf("%w: the endpoint is not an http or https URL", ErrConfig)
	}
	if config.MaxResponseBytes < 0 {
		return nil, fmt.Errorf("%w: the largest response is below zero", ErrConfig)
	}
	if _, err := didkey.PublicKey(config.Operator); err != nil {
		return nil, fmt.Errorf("%w: operator: %w", ErrConfig, err)
	}
	if config.Record == nil {
		return nil, fmt.Errorf("%w: there is no record", ErrConfig)
	}
	parsed, err := terms.Parse(config.Terms)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrConfig, err)
	}

	httpClient := *http.DefaultClient
	if config.HTTPClient != nil {
		httpClient = *config.HTTPClient
	}
	limited := limitedTransport{base: httpClient.Transport, max: config.MaxResponseBytes}
	if limited.base == nil {
		limited.base = http.DefaultTransport
	}
	if limited.max == 0 {
		limited.max = DefaultMaxResponseBytes
	}
	httpClient.Transport = limited
	// A redirect would send the end-user's data to an address other than the endpoint.
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	sdk := mcp.NewClient(&mcp.Implementation{Name: "freehold", Version: version.String()}, &mcp.ClientOptions{
		Capabilities: &mcp.ClientCapabilities{Extensions: map[string]any{extensionID: map[string]any{}}},
		// A request that answers a result's request for input is a new request, which needs its own label.
		MultiRoundTrip: &mcp.MultiRoundTripOptions{Disabled: true},
	})
	// The standalone stream carries messages the server starts, and a Session reads none.
	session, err := sdk.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:             config.Endpoint,
		HTTPClient:           &httpClient,
		DisableStandaloneSSE: true,
		// A response that is read again after a failure would be read past its limit.
		MaxRetries: -1,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("connecting to the server: %w", err)
	}

	advertised, err := readAdvertisement(session.InitializeResult())
	if err == nil && advertised.OperatorDID != config.Operator {
		err = ErrOperator
	}
	if err != nil {
		_ = session.Close()
		return nil, err
	}

	return &Session{
		auditKey:  slices.Clone(config.AuditKey),
		operator:  config.Operator,
		record:    config.Record,
		session:   session,
		terms:     parsed,
		tolerance: advertised.Tolerance,
		written:   slices.Clone(config.Terms),
	}, nil
}

// CallTool calls a tool with data from scope and returns the result with the operator's receipt for the call.
// It sends the terms themselves when the operator does not hold them, as a second request.
// A result that asks for input is returned as it is, and the call that answers it is a new call.
// It returns ErrNotSent when the terms do not permit the operator to serve the call,
// or when the call cannot be encoded or recorded.
// It returns a *Refusal when the operator refuses the call, and ErrUnreceipted when the answer carries no valid receipt.
// It returns ErrOutcomeNotRecorded when the outcome of the call cannot be recorded.
// NOTE: That error can come with a result, which is as valid as a result returned with no error.
func (s *Session) CallTool(ctx context.Context, scope string, params *mcp.CallToolParams) (*ToolResult, error) {
	if _, err := s.terms.Commitment(scope, s.tolerance); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrNotSent, err)
	}

	call := toolCall{scope: scope}
	if params != nil {
		call.params = *params
	}
	// The arguments are encoded once, so the commitment covers the bytes that are sent.
	arguments := jsontext.Value("{}")
	if call.params.Arguments != nil {
		encoded, err := legacyjson.Marshal(call.params.Arguments)
		if err != nil {
			return nil, fmt.Errorf("%w: encoding the arguments: %w", ErrNotSent, err)
		}
		arguments = encoded
	}
	call.params.Arguments = arguments

	var err error
	if call.request, err = requestBytes(methodCallTool, &call.params); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrNotSent, err)
	}

	result, sent, err := s.send(ctx, call, nil)
	if !sent {
		return nil, fmt.Errorf("%w: %w", ErrNotSent, err)
	}
	refused, ok := errors.AsType[*Refusal](err)
	if !ok || refused.Reason != terms.ReasonTermsUnknown || errors.Is(err, ErrOutcomeNotRecorded) {
		return result, err
	}

	// The operator has received the call once, so a failure from here on is not ErrNotSent.
	result, sent, err = s.send(ctx, call, s.written)
	if !sent {
		return nil, fmt.Errorf("%w: the terms were not sent: %w", refused, err)
	}

	return result, err
}

// Close ends the session.
func (s *Session) Close() error {
	return s.session.Close()
}

// exchange sends call under the label of awaited and returns the result with its verified receipt.
// A non-empty written is sent as the terms document.
// It reports how the request ended.
func (s *Session) exchange(
	ctx context.Context, call toolCall, awaited *receipt.Awaited, written jsontext.Value,
) (*ToolResult, Outcome, error) {
	meta := maps.Clone(call.params.Meta)
	if meta == nil {
		meta = mcp.Meta{}
	}
	meta[keyTerms] = newLabel(awaited.Label(), call.scope, written)
	call.params.Meta = meta

	result, err := s.session.CallTool(ctx, &call.params)
	if err != nil {
		if refused := refusalFrom(err); refused != nil {
			return nil, OutcomeRefused, refused
		}

		return nil, OutcomeFailed, err
	}

	var presented []byte
	if signed, ok := result.Meta[keyReceipt]; ok {
		if presented, err = legacyjson.Marshal(signed); err != nil {
			return nil, OutcomeUnreceipted, fmt.Errorf("%w: %w", ErrUnreceipted, err)
		}
	}
	accepted, err := awaited.Accept(presented)
	if err != nil {
		return nil, OutcomeUnreceipted, fmt.Errorf("%w: %w", ErrUnreceipted, err)
	}
	delete(result.Meta, keyReceipt)

	return &ToolResult{Receipt: accepted, Tool: result}, OutcomeReceipted, nil
}

// send makes one request for call, under a new label, and returns the result with its verified receipt.
// A non-empty written is sent as the terms document.
// It reports whether the request was sent.
func (s *Session) send(ctx context.Context, call toolCall, written jsontext.Value) (*ToolResult, bool, error) {
	awaited, err := receipt.Await(s.auditKey, receipt.Request{
		Bytes:    call.request,
		Operator: s.operator,
		Scope:    call.scope,
		Terms:    s.terms,
	})
	if err != nil {
		return nil, false, err
	}

	minted := awaited.Label()
	err = s.record.Record(Sent{
		Label:    minted,
		Method:   methodCallTool,
		Operator: s.operator,
		Scope:    call.scope,
		Time:     time.Now().UTC(),
	})
	if err != nil {
		return nil, false, fmt.Errorf("recording the request: %w", err)
	}

	result, outcome, err := s.exchange(ctx, call, awaited, written)
	if failed := s.record.RecordOutcome(minted, outcome); failed != nil {
		failed = fmt.Errorf("%w: %w", ErrOutcomeNotRecorded, failed)
		if err == nil {
			return result, true, failed
		}

		return result, true, fmt.Errorf("%w: %w", err, failed)
	}

	return result, true, err
}
