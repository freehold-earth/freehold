// Package terms reads a person's terms and decides whether an operator may serve a request made under them.
//
// A person's policy, with everything that identifies them removed, is their terms (spec/protocols/policy-terms.md).
// An agent calls an operator under those terms, naming them by their hash, and the operator checks before it serves
// that it understands them, that one of their rules governs the data the call concerns, and that it can keep what
// that rule asks (spec/protocols/mcp-terms-extension.md). Those checks, and the reasons an operator gives when one
// fails, are this package.
//
// The package reads and decides. Holding terms between requests, and carrying a refusal back to the agent, are for
// its caller.
package terms
