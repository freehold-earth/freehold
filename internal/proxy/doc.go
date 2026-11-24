// Package proxy applies the terms extension of the Model Context Protocol (MCP) in front of an operator's MCP server.
// The extension is earth.freehold/spal, specified in spec/protocols/mcp-terms-extension.md.
// The proxy checks the terms of a request against the operator's tolerance, then refuses or forwards the request.
// A request forwarded under terms carries the conditions the operator has committed to.
// Its result is returned with a receipt signed with the operator's key.
// The proxy records such a request as accepted in the operator's audit record before forwarding it,
// and records the outcome afterwards.
// The proxy adds the operator's advertisement to every discovery result.
// It reads and changes only what the extension names, and leaves the rest of each message as sent.
// NOTE: The proxy does not enforce the commitment, so the upstream server must read and honor it.
package proxy
