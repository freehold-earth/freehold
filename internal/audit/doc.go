// Package audit keeps an operator's own record of the requests it was sent under terms.
//
// The record is a file of lines, one JSON object to a line, that is only ever added to. A line says what the
// operator agreed to for a request, what it signed, or why it refused, and names the request by the terms hash, the
// nonce and the operator's own handle. No line holds anything of what a request or its answer carried.
//
// A line is on disk before Record returns, so that an operator can hold back a request it has no record of.
package audit
