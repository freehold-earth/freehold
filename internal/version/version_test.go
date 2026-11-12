package version

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestString(t *testing.T) {
	t.Parallel()

	// Outside the Makefile nothing is injected, so the defaults show.
	require.Equal(t, "dev (unknown), built unknown", String())
}
