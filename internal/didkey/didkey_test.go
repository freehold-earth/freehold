package didkey

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// testKnownKeys pairs Ed25519 public keys (the first two test keys of RFC 8032, section 7.1) with their did:key
// identifiers.
var testKnownKeys = map[string]struct {
	did    string
	keyHex string
}{
	"RFC 8032 test 1": {
		did:    "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw",
		keyHex: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
	},
	"RFC 8032 test 2": {
		did:    "did:key:z6MkiaMbhXHNA4eJVCCj8dbzKzTgYDKf6crKgHVHid1F1WCT",
		keyHex: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
	},
}

func TestBase58(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		dataHex string
		want    string
	}{
		"empty":                    {dataHex: "", want: ""},
		"one zero byte":            {dataHex: "00", want: "1"},
		"leading zero bytes kept":  {dataHex: "0000287fb4cd", want: "11233QC4"},
		"no leading zero":          {dataHex: "61", want: "2g"},
		"a longer value":           {dataHex: "516b6fcd0f", want: "ABnLTmg"},
		"every byte of a zero run": {dataHex: "00000000000000000000", want: "1111111111"},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			data, err := hex.DecodeString(tc.dataHex)
			require.NoError(t, err)

			require.Equal(t, tc.want, base58Encode(data))

			got, ok := base58Decode(tc.want)
			require.True(t, ok)
			require.Equal(t, tc.dataHex, hex.EncodeToString(got))
		})
	}
}

func TestFromPublicKey(t *testing.T) {
	t.Parallel()

	for name, tc := range testKnownKeys {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			key, err := hex.DecodeString(tc.keyHex)
			require.NoError(t, err)

			got, err := FromPublicKey(key)
			require.NoError(t, err)
			require.Equal(t, tc.did, got)
		})
	}
}

func TestFromPublicKey_WrongLength(t *testing.T) {
	t.Parallel()

	got, err := FromPublicKey(make(ed25519.PublicKey, ed25519.PublicKeySize-1))
	require.ErrorIs(t, err, ErrNotEd25519)
	require.Empty(t, got)
}

func TestMaxEncodedLen(t *testing.T) {
	t.Parallel()

	// The longest identifier belongs to the largest key.
	largest := bytes.Repeat([]byte{0xff}, ed25519.PublicKeySize)
	did, err := FromPublicKey(largest)
	require.NoError(t, err)

	require.Len(t, strings.TrimPrefix(did, prefix), maxEncodedLen)
}

func TestPublicKey(t *testing.T) {
	t.Parallel()

	for name, tc := range testKnownKeys {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got, err := PublicKey(tc.did)
			require.NoError(t, err)
			require.Equal(t, tc.keyHex, hex.EncodeToString(got))
		})
	}
}

func TestPublicKey_Refused(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		did string
	}{
		"empty":                            {did: ""},
		"another DID method":               {did: "did:web:example.org"},
		"not base58 (multibase f)":         {did: "did:key:f6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw"},
		"a character outside base58":       {did: "did:key:z6Mktwupdm0XVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw"},
		"longer than any key's identifier": {did: "did:key:z" + strings.Repeat("z", maxEncodedLen+1)},
		"nothing after the prefix":         {did: "did:key:z"},
		"a key one byte short": {
			did: "did:key:z" + base58Encode(append([]byte{0xed, 0x01}, make([]byte, 31)...)),
		},
		"a key one byte long": {
			did: "did:key:z" + base58Encode(append([]byte{0xed, 0x01}, make([]byte, 33)...)),
		},
		"another key type (P-256)": {did: "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169"},
		"the right length, wrong tag": {
			did: "did:key:z" + base58Encode(append([]byte{0xec, 0x01}, make([]byte, 32)...)),
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got, err := PublicKey(tc.did)
			require.ErrorIs(t, err, ErrNotEd25519)
			require.Nil(t, got)
		})
	}
}
