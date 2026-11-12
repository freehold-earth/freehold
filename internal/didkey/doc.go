// Package didkey turns an Ed25519 public key into its did:key identifier and back.
//
// A did:key is its own key: the identifier is the public key, tagged with its type and written in base58, so whoever
// holds the identifier can check a signature with nothing else. Only Ed25519 keys are handled, the identifiers that
// begin did:key:z6Mk, which is the only kind Freehold signs with.
package didkey
