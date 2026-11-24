// Package client makes requests to an operator's Model Context Protocol (MCP) server under an end-user's terms.
// It is the end-user's side of the terms extension earth.freehold/spal,
// which is specified in spec/protocols/mcp-terms-extension.md.
//
// Connect opens a Session with one operator.
// A Session sends a request only when the terms permit the operator to serve it,
// and only after the request is in the end-user's record.
// It returns a result only with the operator's valid receipt for that request.
// It adds the outcome of each request it sent to the same record.
//
// An error from a Session states how far the request went.
// ErrNotSent means the operator received nothing.
// A *Refusal means the operator received the request and refused it.
// ErrUnreceipted means the operator answered without a valid receipt, and the answer is withheld.
// After any other error the operator may hold the request, and no receipt binds it.
// NOTE: Such an error can hold text that the operator chose, so it should not be given to a model.
// ErrOutcomeNotRecorded means the record does not hold how a request that was sent ended.
// It comes together with the result or the error that the request ended in.
package client
