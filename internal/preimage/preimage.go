package preimage

import (
	"encoding/binary"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"
)

const (
	// byteOrderMark is U+FEFF, which a text field must not begin with.
	byteOrderMark = "\ufeff"

	// maxVariableLength is the longest variable-length field in bytes, which is the largest value its length states.
	maxVariableLength = math.MaxUint32
)

// Field is one field of a preimage.
// A Field is made by Fixed, Text or Variable.
// A Field made from a value that breaks the encoding rule carries the error, and Encode returns it.
type Field struct {
	// err is why the field cannot be encoded, or nil.
	err error

	// prefixed is true for a variable-length field, which is written after its length.
	prefixed bool

	// value is the field's bytes.
	value []byte
}

// Encode returns the canonical bytes of fields, in the order given.
// It returns the error of the first field that carries one: ErrFieldTooLong, ErrFixedWidth or ErrText.
func Encode(fields ...Field) ([]byte, error) {
	var out []byte
	for _, field := range fields {
		if field.err != nil {
			return nil, field.err
		}
		if field.prefixed {
			// The conversion cannot overflow because Variable refuses a value longer than maxVariableLength.
			out = binary.BigEndian.AppendUint32(out, uint32(len(field.value)))
		}
		out = append(out, field.value...)
	}

	return out, nil
}

// Fixed returns a fixed-width field that writes value raw.
// The field carries ErrFixedWidth when value is not exactly width bytes.
func Fixed(value []byte, width int) Field {
	if len(value) != width {
		return Field{err: fmt.Errorf("%w: want %d bytes, got %d", ErrFixedWidth, width, len(value))}
	}

	return Field{value: value}
}

// Text returns a variable-length field that holds the UTF-8 bytes of value exactly as given.
// Nothing is normalized, replaced or stripped, so two values that differ in code points are different fields.
// The field carries ErrText when value is not well-formed UTF-8 or begins with U+FEFF, the byte-order mark.
func Text(value string) Field {
	if !utf8.ValidString(value) {
		return Field{err: fmt.Errorf("%w: not valid UTF-8", ErrText)}
	}
	if strings.HasPrefix(value, byteOrderMark) {
		return Field{err: fmt.Errorf("%w: begins with a byte-order mark", ErrText)}
	}

	return Variable([]byte(value))
}

// Variable returns a variable-length field that writes value after its 4-byte big-endian length.
// The field carries ErrFieldTooLong when value is longer than that length can state.
func Variable(value []byte) Field {
	if uint64(len(value)) > maxVariableLength {
		return Field{
			err: fmt.Errorf("%w: %d bytes, above the maximum of %d", ErrFieldTooLong, len(value), maxVariableLength),
		}
	}

	return Field{prefixed: true, value: value}
}
