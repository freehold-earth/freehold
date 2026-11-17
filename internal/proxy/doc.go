// Package proxy stands in front of an operator's MCP server and answers for the operator under the terms extension,
// earth.freehold/spal (spec/protocols/mcp-terms-extension.md).
//
// An end-user's agent calls an operator under the end-user's terms. For each such request the proxy checks the
// terms against what the operator is able to agree to, and refuses the request or passes it on. A request it passes
// on carries what the operator has thereby committed to, for the server behind to keep, and its result goes back
// with a receipt the proxy signs with the operator's key. A request is in the operator's audit record as accepted
// before it is passed on, and how it ended is recorded after.
//
// The proxy is a desk for refusing and signing. It holds the operator to account and does not make the server
// behind it keep the commitment: that server has to read the commitment and honor it.
//
// Everything else passes through as plain MCP. The proxy is not an MCP server: it reads and changes only what the
// extension names and leaves the rest of each message as it was sent.
package proxy
