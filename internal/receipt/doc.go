// Package receipt signs and checks terms receipts.
// A receipt is an operator's signed statement about a request it served under an end-user's terms.
// The protocol is spec/protocols/terms-receipt.md.
//
// A receipt names the terms, the request, the time it was served and the conditions the operator commits to.
// It identifies the request by a nonce and a commitment that the operator copies and cannot open.
// A receipt therefore records what the operator agreed to, and never the content of the request.
//
// Sign creates a receipt.
// Await labels a request, and Awaited.Accept checks the receipt returned for it.
//
// The package sends nothing and stores nothing.
package receipt
