package preimage

import (
	"encoding/hex"
	"encoding/json/v2"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/spec/schemas"
)

func TestEncode_BoundariesAreFixed(t *testing.T) {
	t.Parallel()

	// Joined raw, both pairs are "alicebob123". The lengths keep them apart.
	a, err := Encode(Text("alice"), Text("bob123"))
	require.NoError(t, err)
	b, err := Encode(Text("aliceb"), Text("ob123"))
	require.NoError(t, err)

	require.Equal(t, "00000005616c69636500000006626f62313233", hex.EncodeToString(a))
	require.Equal(t, "00000006616c69636562000000056f62313233", hex.EncodeToString(b))
}

func TestEncode_Faults(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		fields  []Field
		wantErr error
	}{
		"fixed field too short": {
			fields:  []Field{Text("spal/x"), Fixed([]byte{1, 2, 3}, 4)},
			wantErr: ErrFixedWidth,
		},
		"fixed field too long": {
			fields:  []Field{Text("spal/x"), Fixed([]byte{1, 2, 3, 4, 5}, 4)},
			wantErr: ErrFixedWidth,
		},
		"text that is not UTF-8": {
			fields:  []Field{Text("spal/x"), Text("caf\xff")},
			wantErr: ErrText,
		},
		"first fault wins": {
			fields:  []Field{Text("\ufeffspal/x"), Fixed(nil, 4)},
			wantErr: ErrText,
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got, err := Encode(tc.fields...)
			require.ErrorIs(t, err, tc.wantErr)
			require.Nil(t, got)
		})
	}
}

func TestEncode_NoFields(t *testing.T) {
	t.Parallel()

	got, err := Encode()
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestEncode_SpecVectors(t *testing.T) {
	t.Parallel()

	var file struct {
		Vectors []struct {
			EncodingHex string `json:"encoding_hex"`
			Fields      []struct {
				Kind      string `json:"kind"`
				ValueHex  string `json:"value_hex"`
				ValueUTF8 string `json:"value_utf8"`
				Width     int    `json:"width"`
			} `json:"fields"`
			Name string `json:"name"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(schemas.EncodingVectors(), &file))
	require.NotEmpty(t, file.Vectors)

	for _, tc := range file.Vectors {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			fields := make([]Field, 0, len(tc.Fields))
			for _, f := range tc.Fields {
				raw, err := hex.DecodeString(f.ValueHex)
				require.NoError(t, err)

				switch {
				case f.Kind == "fixed":
					fields = append(fields, Fixed(raw, f.Width))
				case f.ValueHex != "":
					fields = append(fields, Variable(raw))
				default:
					fields = append(fields, Text(f.ValueUTF8))
				}
			}

			got, err := Encode(fields...)
			require.NoError(t, err)
			require.Equal(t, tc.EncodingHex, hex.EncodeToString(got))
		})
	}
}

func TestText_Refused(t *testing.T) {
	t.Parallel()

	// The values the specification's vector file says a text field must refuse ("text-field-encoding").
	tests := map[string]struct {
		text string
	}{
		"a leading byte-order mark":               {text: "\ufeffcaf\u00e9"},
		"a leading byte-order mark, as its bytes": {text: "\xef\xbb\xbfcaf\xc3\xa9"},
		"a byte that is never UTF-8":              {text: "caf\xff"},
		"a surrogate written as three bytes":      {text: "caf\xed\xa0\x80"},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got, err := Encode(Text(tc.text))
			require.ErrorIs(t, err, ErrText)
			require.Nil(t, got)
		})
	}
}
