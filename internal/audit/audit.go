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

// The outcomes of a request.
const (
	// OutcomeAccepted means the operator accepted the request under the conditions in the entry.
	OutcomeAccepted Outcome = "accepted"

	// OutcomeFailed means an accepted request ended without a result and without a receipt.
	// The operator was still sent the request, and the conditions it accepted still bind.
	OutcomeFailed Outcome = "failed"

	// OutcomeRefused means the operator refused the request for the reason in the entry.
	OutcomeRefused Outcome = "refused"

	// OutcomeServed means the operator answered an accepted request and signed the receipt in the entry.
	// NOTE: It does not mean that the answer was delivered.
	OutcomeServed Outcome = "served"
)

// ownerOnly is the permission of a new record file, which only its owner may read and write.
const ownerOnly fs.FileMode = 0o600

// Entry is one line of the record, which states the outcome of one request.
// The fields that apply depend on the outcome, and a field that does not apply is left empty and is not written.
// The fields are in wire order.
type Entry struct {
	// Time is when the line was recorded.
	Time time.Time `json:"time"`

	// Outcome is the outcome of the request.
	Outcome Outcome `json:"outcome"`

	// Method is the kind of request, as its protocol names it.
	Method string `json:"method"`

	// RequestID is the operator's ID for the request, shared by its accepted entry and the entry that follows it.
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

	// Condition is the condition a refusal concerns, for a reason that names one.
	Condition string `json:"condition,omitzero"`

	// Receipt is the receipt the operator signed for a served request.
	Receipt *receipt.Receipt `json:"receipt,omitzero"`
}

// Log is an operator's record, open for appending.
// It is safe for concurrent use.
// NOTE: A Log must be created by Open.
// NOTE: After a line fails to be recorded, a Log records nothing more, because a later line would extend a partial one.
type Log struct {
	// failed is the error that stopped the Log, or nil.
	failed error

	// file is the record file.
	file *os.File

	// mu serializes writes, so that concurrent lines do not interleave.
	mu sync.Mutex
}

// Outcome is the outcome of a request that an operator was sent.
type Outcome string

// Open opens the record in the file at path for appending and keeps its existing content.
// It creates a missing file, which only its owner may read and write.
// It terminates a partial last line, so that each later line starts on a line of its own.
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

// Close closes the record.
// A closed Log records nothing more.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if err := l.file.Close(); err != nil {
		return fmt.Errorf("closing the audit record: %w", err)
	}

	return nil
}

// Record appends entry to the record as one line.
// The line is on disk when Record returns nil.
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

// endLastLine appends a line ending to file when its content does not end in one.
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
