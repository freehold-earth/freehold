// Package preimage builds the canonical bytes that Freehold structures are hashed and signed over.
//
// The rule is the one in spec/protocols/preimage-encoding.md. A preimage is an ordered list of fields. A
// variable-length field is written as a 4-byte big-endian length followed by its bytes; a fixed-width field is written
// raw at the width its structure pins. Every boundary is fixed by a length or a width, so no two different lists of
// fields produce the same bytes.
//
// The package knows the rule and nothing of the structures that use it: which fields a structure has, and in which
// order, is for the package that owns the structure.
package preimage
