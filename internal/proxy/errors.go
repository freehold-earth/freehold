package proxy

import "errors"

// ErrConfig is returned when a proxy cannot be created from its configuration.
var ErrConfig = errors.New("proxy configuration is not usable")
