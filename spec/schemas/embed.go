package schemas

import (
	"bytes"

	_ "embed"
)

var (
	// commitmentVectors is the operator commitment's vector file.
	//
	//go:embed spal/v1.0/commitment-vectors.json
	commitmentVectors []byte

	// encodingVectors is the canonical preimage encoding's vector file.
	//
	//go:embed encoding/v1.0/test-vectors.json
	encodingVectors []byte

	// termsVectors is the policy terms' vector file.
	//
	//go:embed spal/v1.0/terms-vectors.json
	termsVectors []byte
)

// CommitmentVectors returns the test vectors of what an operator commits to or refuses under a person's terms
// (protocols/mcp-terms-extension.md), as the JSON document the specification publishes.
func CommitmentVectors() []byte {
	return bytes.Clone(commitmentVectors)
}

// EncodingVectors returns the test vectors of the canonical preimage encoding (protocols/preimage-encoding.md), as
// the JSON document the specification publishes.
func EncodingVectors() []byte {
	return bytes.Clone(encodingVectors)
}

// TermsVectors returns the test vectors of a policy's terms and their hash (protocols/policy-terms.md), as the JSON
// document the specification publishes.
func TermsVectors() []byte {
	return bytes.Clone(termsVectors)
}
