package preimage

import "errors"

var (
	// ErrFieldTooLong is returned when a variable-length field is longer than its 4-byte length can state.
	ErrFieldTooLong = errors.New("variable-length field is too long")

	// ErrFixedWidth is returned when a fixed-width field's value is not exactly as wide as its structure pins.
	ErrFixedWidth = errors.New("fixed-width field has the wrong width")

	// ErrText is returned when a text value is not well-formed UTF-8 or begins with a byte-order mark.
	ErrText = errors.New("text field is not well-formed")
)
