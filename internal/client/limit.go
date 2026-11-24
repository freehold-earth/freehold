package client

import (
	"io"
	"net/http"
)

// limitedBody is a response body that fails with errResponseTooLarge once more than its limit is read.
type limitedBody struct {
	io.ReadCloser

	// remaining is the number of bytes that may still be read.
	remaining int64
}

// limitedTransport is an http.RoundTripper that limits the size of each response body.
type limitedTransport struct {
	// base makes the requests.
	base http.RoundTripper

	// max is the limit on the size of a response body in bytes.
	max int64
}

// Read reads from the body, and fails once the body exceeds the limit.
func (b *limitedBody) Read(p []byte) (int, error) {
	if b.remaining < 0 {
		return 0, errResponseTooLarge
	}

	n, err := b.ReadCloser.Read(p)
	b.remaining -= int64(n)
	if b.remaining < 0 {
		return 0, errResponseTooLarge
	}

	return n, err
}

// RoundTrip makes the request and returns the response with a limited body.
func (l limitedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := l.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	response.Body = &limitedBody{ReadCloser: response.Body, remaining: l.max}

	return response, nil
}
