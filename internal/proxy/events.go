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

const (
	// byteOrderMark is the byte order mark that an event stream may start with.
	byteOrderMark = "\ufeff"

	// dataField is the prefix of an event line that carries data.
	dataField = "data:"
)

// errTooLarge is the error for an event that exceeds the size limit.
var errTooLarge = errors.New("an event of the server's stream is larger than the proxy reads")

// eventRewriter is an io.ReadCloser that rewrites each JSON-RPC response in an event stream for one exchange.
// Events that are not responses pass through unchanged.
type eventRewriter struct {
	// begun is true once the first line of the stream has been read.
	begun bool

	// body is the upstream event stream.
	body io.ReadCloser

	// err is the error that ended the stream, or nil.
	err error

	// ex is the exchange that the stream answers.
	ex *exchange

	// lines reads the stream one line at a time.
	lines *bufio.Scanner

	// maxEvent is the maximum size of one event in bytes.
	maxEvent int

	// pending holds the rewritten bytes that have not been read.
	pending bytes.Buffer
}

// newEventRewriter returns an eventRewriter that reads body and rewrites its responses for ex.
// An event larger than maxEvent bytes ends the stream with an error.
func newEventRewriter(body io.ReadCloser, ex *exchange, maxEvent int64) *eventRewriter {
	lines := bufio.NewScanner(body)
	lines.Split(splitLines())
	lines.Buffer(make([]byte, 0, min(bufio.MaxScanTokenSize, int(maxEvent))), int(maxEvent))

	return &eventRewriter{body: body, ex: ex, lines: lines, maxEvent: int(maxEvent)}
}

// Close closes the upstream event stream.
// It records an accepted request that has had no response as failed.
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

// emit writes event to pending, with its data rewritten when the data is a JSON-RPC response.
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

	// Data that is not a JSON object is not a JSON-RPC message, so it passes through unchanged.
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

// next reads the next event from the upstream stream and writes it to pending.
// It returns io.EOF when the stream has ended.
func (r *eventRewriter) next() error {
	var event []string
	size := 0
	for r.lines.Scan() {
		line := r.lines.Text()
		if !r.begun {
			// The byte order mark is not part of the first line.
			line = strings.TrimPrefix(line, byteOrderMark)
			r.begun = true
		}
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
	// An incomplete event at the end of the stream is dropped, because a client discards it.
	return io.EOF
}

// splitLines returns a bufio.SplitFunc for the lines of an event stream.
// A line ends in a line feed, a carriage return, or a carriage return followed by a line feed.
// A line that ends in a carriage return is returned without waiting for a line feed,
// because the stream may stay open after it.
func splitLines() bufio.SplitFunc {
	// afterReturn is true when the previous line ended in a carriage return.
	// A line feed that follows belongs to that line.
	afterReturn := false

	return func(data []byte, atEOF bool) (advance int, token []byte, err error) {
		skipped := 0
		if afterReturn && len(data) > 0 {
			if data[0] == '\n' {
				skipped = 1
			}
			afterReturn = false
		}
		rest := data[skipped:]

		end := bytes.IndexAny(rest, "\r\n")
		if end < 0 {
			if atEOF && len(rest) > 0 {
				return len(data), rest, nil
			}

			return skipped, nil, nil
		}
		afterReturn = rest[end] == '\r'

		return skipped + end + 1, rest[:end], nil
	}
}
