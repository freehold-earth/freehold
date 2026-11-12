// Package receipt signs terms receipts: an operator's statement about a request it served under a person's terms.
//
// The protocol is spec/protocols/terms-receipt.md. A receipt says which terms a request was served under, which
// request it was, when, and the conditions the operator commits to for it. The request is named by a nonce and a
// commitment that the person's agent sent with it; the operator copies both and cannot open either, so a receipt
// says what the operator agreed to and never what it saw.
//
// This is the operator's half: Sign makes a Receipt from a Statement. Checking a receipt against the request it
// answers is the agent's half and is not here.
package receipt
