// Package audit keeps an operator's own record of the requests it was sent under terms.
//
// The record is a file of lines, one JSON object to a line, that is only ever added to. A line says what the
// operator agreed to for a request, what it signed, or why it refused, and names the request by the terms hash, the
// nonce and the operator's own handle. No line holds anything of what a request or its answer carried.
//
// A line is on disk before Record returns, so that an operator can hold back a request it has no record of.
//
// A write that is cut short, by a full disk or a loss of power, can leave part of a line behind. The part is never
// removed or written over: it is closed off as a line of its own when the record is next opened, and is then the
// one line in the file that is not a JSON object. A reader of the record skips such a line and takes it as the
// mark of an interruption.
package audit
