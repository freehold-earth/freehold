// Package preimage builds the canonical bytes that Freehold structures are hashed and signed over.
//
// A preimage is an ordered list of fields, encoded by the rule in spec/protocols/preimage-encoding.md.
// A variable-length field is written as a 4-byte big-endian length followed by its bytes.
// A fixed-width field is written raw at the width that its structure sets.
// Every boundary is fixed by a length or a width, so no two different values of a structure produce the same bytes.
//
// The package holds the rule only.
// It does not know the fields of any structure or their order.
package preimage
