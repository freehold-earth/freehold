package spal

import "errors"

// ErrInvalid is returned when a value is not one the S-PAL schema allows for its field.
var ErrInvalid = errors.New("not a value S-PAL allows")
