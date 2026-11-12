package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/version"
)

func TestRootCmd(t *testing.T) {
	tests := map[string]struct {
		args []string
		want string
	}{
		"version flag prints the name and the build": {
			args: []string{"--version"},
			want: "freehold " + version.String() + "\n",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			cmd := newRootCmd()
			cmd.SetOut(&out)
			cmd.SetArgs(tc.args)

			require.NoError(t, cmd.Execute())
			require.Equal(t, tc.want, out.String())
		})
	}
}
