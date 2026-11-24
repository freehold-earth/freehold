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

// CommitmentVectors returns a copy of the test vectors for an operator's commitment or refusal under end-user terms.
// The vectors are the JSON document that the specification publishes for protocols/mcp-terms-extension.md.
func CommitmentVectors() []byte {
	return bytes.Clone(commitmentVectors)
}

// EncodingVectors returns a copy of the test vectors for the canonical preimage encoding.
// The vectors are the JSON document that the specification publishes for protocols/preimage-encoding.md.
func EncodingVectors() []byte {
	return bytes.Clone(encodingVectors)
}

// TermsVectors returns a copy of the test vectors for a policy's terms and their hash.
// The vectors are the JSON document that the specification publishes for protocols/policy-terms.md.
func TermsVectors() []byte {
	return bytes.Clone(termsVectors)
}
