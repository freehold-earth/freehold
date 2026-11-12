package version

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestString(t *testing.T) {
	t.Parallel()

	// Nothing is injected in a test build, so the defaults show.
	require.Equal(t, "dev (unknown), built unknown", String())
}
