package main

import (
	"bytes"
	"crypto/ed25519"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/keyfile"
)

func TestKeyNewCmd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operator.pem")

	var out bytes.Buffer
	cmd := newRootCmd()
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"key", "new", path})
	require.NoError(t, cmd.Execute())

	key, err := keyfile.Read(path)
	require.NoError(t, err)
	want, err := didkey.FromPublicKey(key.Public().(ed25519.PublicKey))
	require.NoError(t, err)
	require.Equal(t, want+"\n", out.String())
}

func TestKeyNewCmd_OutputFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "operator.pem")

	// A file that is closed is an output that cannot be written to.
	closed, err := os.Create(filepath.Join(dir, "out"))
	require.NoError(t, err)
	require.NoError(t, closed.Close())

	cmd := newRootCmd()
	cmd.SetOut(closed)
	cmd.SetArgs([]string{"key", "new", path})
	err = cmd.Execute()

	key, readErr := keyfile.Read(path)
	require.NoError(t, readErr)
	did, didErr := didkey.FromPublicKey(key.Public().(ed25519.PublicKey))
	require.NoError(t, didErr)
	require.ErrorIs(t, err, os.ErrClosed)
	require.ErrorContains(t, err, "the key is in "+path+" and its identifier is "+did)
}

func TestKeyNewCmd_Refuses(t *testing.T) {
	taken := filepath.Join(t.TempDir(), "operator.pem")
	_, err := keyfile.Create(taken)
	require.NoError(t, err)

	tests := map[string]struct {
		args    []string
		wantErr string
	}{
		"a file that is already there": {
			args:    []string{"key", "new", taken},
			wantErr: "file already exists: " + taken,
		},
		"no file named": {
			args:    []string{"key", "new"},
			wantErr: "accepts 1 arg(s), received 0",
		},
		"two files named": {
			args:    []string{"key", "new", "one.pem", "two.pem"},
			wantErr: "accepts 1 arg(s), received 2",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			cmd := newRootCmd()
			cmd.SetOut(&out)
			cmd.SetErr(&out)
			cmd.SetArgs(tc.args)

			require.EqualError(t, cmd.Execute(), tc.wantErr)
			require.Empty(t, out.String())
		})
	}
}
