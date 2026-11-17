package audit

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sync"
	"time"

	"github.com/freehold-earth/freehold/internal/receipt"
	"github.com/freehold-earth/freehold/internal/spal"
	"github.com/freehold-earth/freehold/internal/terms"
)

// What became of a request, as a line records it.
const (
	// OutcomeAccepted says the operator took the request on under the conditions the line gives. It is recorded
	// before the request goes any further.
	OutcomeAccepted Outcome = "accepted"

	// OutcomeFailed says an accepted request ended without a result, and so without a receipt. The operator was
	// still sent it, and the conditions it accepted still bind.
	OutcomeFailed Outcome = "failed"

	// OutcomeRefused says the operator refused the request and gives the reason.
	OutcomeRefused Outcome = "refused"

	// OutcomeServed says an accepted request was answered, and holds the receipt the operator signed for it. It
	// says the operator signed, and not that the answer reached whoever asked.
	OutcomeServed Outcome = "served"
)

// ownerOnly is the permission a new record is made with: its owner may read and write it, and nobody else.
const ownerOnly fs.FileMode = 0o600

// Entry is one line of the record: what became of one request.
//
// Which fields a line has depends on its outcome. A field that does not apply is left empty and is not written.
type Entry struct {
	// Time is when the line was recorded.
	Time time.Time `json:"time"`

	// Outcome is what became of the request.
	Outcome Outcome `json:"outcome"`

	// Method is the kind of request it was, as its protocol names it.
	Method string `json:"method"`

	// RequestID is the operator's own handle for the request, which ties its accepted line to the one that follows.
	// A refused request has none.
	RequestID string `json:"request_id,omitzero"`

	// TermsHash is the hash of the terms the request named, in lowercase hex.
	TermsHash string `json:"terms_hash,omitzero"`

	// Nonce is the nonce the request was sent with, in lowercase hex.
	Nonce string `json:"nonce,omitzero"`

	// ContextScope is the scope of the data the request concerned.
	ContextScope string `json:"context_scope,omitzero"`

	// Conditions is what the operator committed to for an accepted request.
	Conditions *spal.Conditions `json:"conditions,omitzero"`

	// Reason is why a refused request was refused.
	Reason terms.Reason `json:"reason,omitzero"`

	// Condition names what a refusal is about, for the reasons that name something.
	Condition string `json:"condition,omitzero"`

	// Receipt is the receipt the operator signed for a served request.
	Receipt *receipt.Receipt `json:"receipt,omitzero"`
}

// Log is an operator's record, open for adding to. It is safe for use by several goroutines at once.
//
// A Log comes from Open. Once a line fails to be recorded, the Log records nothing more: part of the line may be in
// the file, and a line added after it would run on from that part.
type Log struct {
	// failed is why the Log records nothing more, once a line has failed to be recorded.
	failed error

	// file is the record.
	file *os.File

	// mu makes each line one write, so that lines recorded at the same moment do not run into each other.
	mu sync.Mutex
}

// Outcome is what became of a request an operator was sent.
type Outcome string

// Open opens the record in the file at path for adding to, and makes the file, for its owner alone to read, if it
// is not there. What the file already holds is kept. Where it ends in part of a line, which a write that failed
// leaves behind, the part is closed off as a line of its own, so that the lines added after it stand alone.
func Open(path string) (*Log, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_APPEND|os.O_CREATE, ownerOnly)
	if err != nil {
		return nil, fmt.Errorf("opening the audit record: %w", err)
	}

	if err := endLastLine(file); err != nil {
		return nil, errors.Join(fmt.Errorf("opening the audit record: %w", err), file.Close())
	}

	return &Log{file: file}, nil
}

// Close closes the record. A Log that is closed records nothing more.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if err := l.file.Close(); err != nil {
		return fmt.Errorf("closing the audit record: %w", err)
	}

	return nil
}

// Record adds entry to the record as one line, and returns once the line is on disk.
func (l *Log) Record(entry Entry) error {
	line, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("encoding an audit line: %w", err)
	}
	line = append(line, '\n')

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.failed != nil {
		return fmt.Errorf("the audit record stopped at an earlier failure: %w", l.failed)
	}
	if _, err := l.file.Write(line); err != nil {
		l.failed = err
		return fmt.Errorf("writing an audit line: %w", err)
	}
	if err := l.file.Sync(); err != nil {
		l.failed = err
		return fmt.Errorf("writing an audit line to disk: %w", err)
	}

	return nil
}

// endLastLine adds a line ending to file if what it holds does not end in one.
func endLastLine(file *os.File) error {
	info, err := file.Stat()
	if err != nil || info.Size() == 0 {
		return err
	}

	last := make([]byte, 1)
	if _, err := file.ReadAt(last, info.Size()-1); err != nil {
		return err
	}
	if last[0] == '\n' {
		return nil
	}
	if _, err := file.Write([]byte{'\n'}); err != nil {
		return err
	}

	return file.Sync()
}
