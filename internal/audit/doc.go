// Package audit keeps an operator's record of the requests it was sent under terms.
//
// The record is an append-only file that holds one JSON object per line.
// A line states what the operator agreed to for a request, what it signed, or why it refused.
// A line identifies the request by the terms hash, the nonce and the operator's request ID.
// No line holds any content of a request or of its response.
//
// A line is on disk before Record returns.
//
// NOTE: An interrupted write can leave a partial line in the file.
// Open terminates a partial line and never removes or overwrites it.
// A line that is not a JSON object therefore marks an interrupted write.
package audit
