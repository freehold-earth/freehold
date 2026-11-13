// Package terms reads a person's terms and decides whether an operator may serve a request made under them.
//
// A person's policy, with everything that identifies them removed, is their terms (spec/protocols/policy-terms.md).
// An agent calls an operator under those terms, naming them by their hash, and the operator checks before it serves
// that it understands them, that one of their rules governs the data the call concerns, and that the rule is within
// what the operator is able to agree to (spec/protocols/mcp-terms-extension.md). An operator that serves the call
// commits to what that rule permits and to nothing of its own choosing. Those checks, the commitment, and the reasons
// an operator gives when a check fails, are this package.
//
// The package reads and decides. It keeps no terms between calls and sends nothing.
package terms
