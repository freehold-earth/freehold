package client

import "errors"

var (
	// ErrConfig is returned when a session cannot be opened from its configuration.
	ErrConfig = errors.New("client configuration is not usable")

	// ErrExtension is returned when a server does not advertise the terms extension with a valid tolerance.
	ErrExtension = errors.New("the server does not advertise the terms extension")

	// ErrNotSent is returned when a request is stopped before any of it is sent.
	ErrNotSent = errors.New("the request was not sent")

	// ErrOperator is returned when a server advertises an operator other than the configured one.
	ErrOperator = errors.New("the server advertises another operator")

	// ErrOutcomeNotRecorded is returned when a request was sent and its outcome cannot be added to the record.
	ErrOutcomeNotRecorded = errors.New("the outcome of the request was not recorded")

	// ErrUnreceipted is returned when an operator answers a request without a valid receipt.
	ErrUnreceipted = errors.New("the answer carries no valid receipt")

	// errResponseTooLarge is the error for a response that is larger than the configured limit.
	errResponseTooLarge = errors.New("the response is larger than the limit")
)
