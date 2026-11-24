// Package terms reads an end-user's terms and decides whether an operator may serve a request made under them.
// The terms are an end-user's policy with every identifying detail removed (spec/protocols/policy-terms.md).
//
// An operator checks three things before it serves a request (spec/protocols/mcp-terms-extension.md).
// It understands the terms, one of their rules governs the data, and the operator can agree to that rule.
// An operator that serves the request commits to what the rule permits.
// The package provides those checks, the commitment, the refusal reasons and the limits of a rule.
//
// The package keeps no terms between calls and sends nothing.
package terms
