package schemas

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestVectors(t *testing.T) {
	tests := map[string]struct {
		vectors func() []byte
	}{
		"commitment": {vectors: CommitmentVectors},
		"encoding":   {vectors: EncodingVectors},
		"terms":      {vectors: TermsVectors},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			var file struct {
				Vectors []jsontext.Value `json:"vectors"`
			}
			require.NoError(t, json.Unmarshal(tc.vectors(), &file))
			require.NotEmpty(t, file.Vectors)
		})
	}
}

func TestVectors_AreTheCallersOwnCopy(t *testing.T) {
	first := EncodingVectors()
	first[0] = 0

	require.NotEqual(t, first[0], EncodingVectors()[0])
}
