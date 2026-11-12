package preimage

import (
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/spec/schemas"
)

// rejectedText is one text value the specification says a text field must refuse.
type rejectedText struct {
	// BytesHex is the value as bytes, for a value given that way.
	BytesHex string `json:"bytes_hex"`

	// CodePoints is the value as code points written U+XXXX, for a value given that way.
	CodePoints []string `json:"code_points"`

	// Name is the case's name.
	Name string `json:"name"`
}

// vector is one structure from the specification with the bytes it must encode to.
type vector struct {
	// EncodingHex is the canonical encoding.
	EncodingHex string `json:"encoding_hex"`

	// Fields are the structure's fields, in order.
	Fields []vectorField `json:"fields"`

	// Name is the vector's name.
	Name string `json:"name"`
}

// vectorField is one field of a vector.
type vectorField struct {
	// Kind is "var" for a variable-length field and "fixed" for a fixed-width one.
	Kind string `json:"kind"`

	// ValueHex is the field's bytes, for a field given as bytes.
	ValueHex *string `json:"value_hex"`

	// ValueUTF8 is the field's text, for a field given as text.
	ValueUTF8 *string `json:"value_utf8"`

	// Width is the pinned width of a fixed-width field.
	Width int `json:"width"`
}

// vectors is the part of the specification's vector file these tests read.
type vectors struct {
	// Validation holds the cases an encoder must refuse.
	Validation []struct {
		// MustReject is the list of refused values, where the case is a list.
		MustReject jsontext.Value `json:"must_reject"`

		// Name is the case's name.
		Name string `json:"name"`
	} `json:"validation"`

	// Vectors are the structures and their encodings.
	Vectors []vector `json:"vectors"`
}

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

	for _, tc := range loadVectors(t).Vectors {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			fields := make([]Field, 0, len(tc.Fields))
			for _, f := range tc.Fields {
				fields = append(fields, f.field(t))
			}

			got, err := Encode(fields...)
			require.NoError(t, err)
			require.Equal(t, tc.EncodingHex, hex.EncodeToString(got))
		})
	}
}

func TestText_SpecRejections(t *testing.T) {
	t.Parallel()

	var cases []rejectedText
	for _, validation := range loadVectors(t).Validation {
		if validation.Name == "text-field-encoding" {
			require.NoError(t, json.Unmarshal(validation.MustReject, &cases))
		}
	}
	require.NotEmpty(t, cases, "the specification's text cases were not found")

	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			_, err := Encode(Text(tc.text(t)))
			require.ErrorIs(t, err, ErrText)
		})
	}
}

// field turns a vector's field into the Field it describes.
func (f vectorField) field(t *testing.T) Field {
	t.Helper()

	var value []byte
	switch {
	case f.ValueUTF8 != nil && f.Kind == "var":
		return Text(*f.ValueUTF8)
	case f.ValueHex != nil:
		decoded, err := hex.DecodeString(*f.ValueHex)
		require.NoError(t, err)
		value = decoded
	default:
		require.FailNow(t, "a vector field has no value this test can read")
	}

	if f.Kind == "fixed" {
		return Fixed(value, f.Width)
	}

	return Variable(value)
}

// loadVectors reads the specification's vector file.
func loadVectors(t *testing.T) vectors {
	t.Helper()

	var out vectors
	require.NoError(t, json.Unmarshal(schemas.EncodingVectors(), &out))
	require.NotEmpty(t, out.Vectors)

	return out
}

// text returns the refused value as a Go string.
func (r rejectedText) text(t *testing.T) string {
	t.Helper()

	if r.BytesHex != "" {
		decoded, err := hex.DecodeString(r.BytesHex)
		require.NoError(t, err)
		return string(decoded)
	}

	var out []byte
	for _, codePoint := range r.CodePoints {
		value, err := strconv.ParseUint(strings.TrimPrefix(codePoint, "U+"), 16, 32)
		require.NoError(t, err)
		if value >= 0xD800 && value <= 0xDFFF {
			// A Go string can only carry a lone surrogate as the three bytes it would have had,
			// were it a scalar value; string(rune) would quietly swap in U+FFFD.
			out = append(out, 0xE0|byte(value>>12), 0x80|byte(value>>6)&0x3F, 0x80|byte(value)&0x3F)
			continue
		}
		out = append(out, string(rune(value))...)
	}

	return string(out)
}
