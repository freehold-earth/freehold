package keyfile

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCreate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operator.pem")

	key, err := Create(path)
	require.NoError(t, err)
	require.Len(t, key, ed25519.PrivateKeySize)

	info, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, ownerOnly, info.Mode().Perm())

	stored, err := Read(path)
	require.NoError(t, err)
	require.Equal(t, key, stored)
}

func TestCreate_MakesADifferentKeyEachTime(t *testing.T) {
	dir := t.TempDir()

	first, err := Create(filepath.Join(dir, "first.pem"))
	require.NoError(t, err)
	second, err := Create(filepath.Join(dir, "second.pem"))
	require.NoError(t, err)

	require.NotEqual(t, first, second)
}

func TestCreate_NeverWritesOverAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operator.pem")
	require.NoError(t, os.WriteFile(path, []byte("already here"), ownerOnly))

	_, err := Create(path)
	require.ErrorIs(t, err, ErrExists)

	kept, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, "already here", string(kept))
}

func TestCreate_NoSuchDirectory(t *testing.T) {
	_, err := Create(filepath.Join(t.TempDir(), "missing", "operator.pem"))
	require.ErrorIs(t, err, fs.ErrNotExist)
	require.NotErrorIs(t, err, ErrExists)
}

func TestRead_NoSuchFile(t *testing.T) {
	_, err := Read(filepath.Join(t.TempDir(), "operator.pem"))
	require.ErrorIs(t, err, fs.ErrNotExist)
}

func TestRead_NotAKey(t *testing.T) {
	_, ed25519Key, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	ed25519DER, err := x509.MarshalPKCS8PrivateKey(ed25519Key)
	require.NoError(t, err)
	valid := string(pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: ed25519DER}))

	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), nil)
	require.NoError(t, err)
	ecdsaDER, err := x509.MarshalPKCS8PrivateKey(ecdsaKey)
	require.NoError(t, err)

	tests := map[string]string{
		"a block of another type": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: ed25519DER})),
		"a block that is not PKCS #8": string(
			pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: []byte("junk")}),
		),
		"a broken block before a key":    "-----BEGIN PRIVATE KEY-----\nnot base64!\n" + valid,
		"a file larger than any key":     valid + strings.Repeat("\n", maxSize),
		"a key followed by a second key": valid + valid,
		"a key followed by other text":   valid + "something else\n",
		"a key that is not Ed25519":      string(pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: ecdsaDER})),
		"a key with a header": string(pem.EncodeToMemory(&pem.Block{
			Type:    blockType,
			Headers: map[string]string{"Comment": "a note"},
			Bytes:   ed25519DER,
		})),
		"an empty file":        "",
		"text before a key":    "a note\n" + valid,
		"text that is not PEM": "not a key\n",
	}

	for name, content := range tests {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "operator.pem")
			require.NoError(t, os.WriteFile(path, []byte(content), ownerOnly))

			_, err := Read(path)
			require.ErrorIs(t, err, ErrNotKey)
		})
	}
}

func TestRead_NotAKeyKeepsTheKeyOutOfTheError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operator.pem")
	secret := base64.StdEncoding.EncodeToString([]byte("secret-key-material"))
	content := "-----BEGIN PRIVATE KEY-----\n" + secret + "\n-----END PRIVATE KEY-----\n"
	require.NoError(t, os.WriteFile(path, []byte(content), ownerOnly))

	_, err := Read(path)
	require.ErrorIs(t, err, ErrNotKey)
	require.NotContains(t, err.Error(), secret)
	require.NotContains(t, err.Error(), "secret-key-material")
}

func TestRead_Shared(t *testing.T) {
	tests := map[string]fs.FileMode{
		"readable by everyone":   0o604,
		"readable by the group":  0o640,
		"the usual file default": 0o644,
		"writable by the group":  0o620,
	}

	for name, mode := range tests {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "operator.pem")
			_, err := Create(path)
			require.NoError(t, err)
			require.NoError(t, os.Chmod(path, mode))

			_, err = Read(path)
			require.ErrorIs(t, err, ErrShared)
		})
	}
}

func TestRead_TrailingBlankLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "operator.pem")
	key, err := Create(path)
	require.NoError(t, err)

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, ownerOnly)
	require.NoError(t, err)
	_, err = file.WriteString("\n\n")
	require.NoError(t, err)
	require.NoError(t, file.Close())

	stored, err := Read(path)
	require.NoError(t, err)
	require.Equal(t, key, stored)
}
