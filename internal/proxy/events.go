package proxy

import (
	"bufio"
	"bytes"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/freehold-earth/freehold/internal/audit"
)

// dataField begins a line of an event that carries its data.
const dataField = "data:"

// errTooLarge is why a stream with an event larger than the proxy reads is cut short.
var errTooLarge = errors.New("an event of the server's stream is larger than the proxy reads")

// eventRewriter reads a server's stream of events and gives it back with each JSON-RPC response in it rewritten for
// one exchange. Events that are not responses pass as they came, as soon as they come.
type eventRewriter struct {
	// body is the server's stream.
	body io.ReadCloser

	// err is why the stream has ended, once it has.
	err error

	// ex is the exchange the stream answers.
	ex *exchange

	// lines reads the stream a line at a time.
	lines *bufio.Scanner

	// maxEvent is the most bytes one event may hold.
	maxEvent int

	// pending is what has been rewritten and not yet read.
	pending bytes.Buffer
}

// newEventRewriter returns body with its responses rewritten for ex. No event of the stream may hold more than
// maxEvent bytes.
func newEventRewriter(body io.ReadCloser, ex *exchange, maxEvent int64) *eventRewriter {
	lines := bufio.NewScanner(body)
	lines.Buffer(make([]byte, 0, min(bufio.MaxScanTokenSize, int(maxEvent))), int(maxEvent))

	return &eventRewriter{body: body, ex: ex, lines: lines, maxEvent: int(maxEvent)}
}

// Close closes the server's stream. An accepted request that has had no response by then is recorded as failed.
func (r *eventRewriter) Close() error {
	r.ex.finish(audit.OutcomeFailed, nil)

	return r.body.Close()
}

// Read reads the rewritten stream.
func (r *eventRewriter) Read(p []byte) (int, error) {
	for r.pending.Len() == 0 {
		if r.err != nil {
			return 0, r.err
		}
		r.err = r.next()
	}

	return r.pending.Read(p)
}

// emit writes one event, as the lines it came in, to pending, with its data rewritten where the data is a JSON-RPC
// response.
func (r *eventRewriter) emit(event []string) error {
	var data []string
	var rest []string
	for _, line := range event {
		if value, ok := strings.CutPrefix(line, dataField); ok {
			data = append(data, strings.TrimPrefix(value, " "))
		} else {
			rest = append(rest, line)
		}
	}

	// Data that is not a JSON object is no JSON-RPC message, and is the client's to make sense of.
	message := strings.Join(data, "\n")
	if value := jsontext.Value(message); value.IsValid() && value.Kind() == '{' {
		rewritten, err := r.ex.rewrite([]byte(message))
		if err != nil {
			return err
		}
		if string(rewritten) != message {
			event = append(rest, dataField+" "+string(rewritten))
		}
	}

	for _, line := range event {
		r.pending.WriteString(line)
		r.pending.WriteByte('\n')
	}
	r.pending.WriteByte('\n')

	return nil
}

// next reads the next event from the server and writes it to pending. It returns io.EOF when the stream has ended.
func (r *eventRewriter) next() error {
	var event []string
	size := 0
	for r.lines.Scan() {
		line := r.lines.Text()
		if size += len(line); size > r.maxEvent {
			return errTooLarge
		}
		if line == "" {
			if len(event) == 0 {
				continue
			}

			return r.emit(event)
		}
		event = append(event, line)
	}
	if err := r.lines.Err(); errors.Is(err, bufio.ErrTooLong) {
		return errTooLarge
	} else if err != nil {
		return fmt.Errorf("reading the server's stream: %w", err)
	}
	// An event the stream ended in the middle of is not one: a client discards it, so it is not passed on.
	return io.EOF
}
