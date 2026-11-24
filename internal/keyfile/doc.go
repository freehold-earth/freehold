// Package keyfile stores an operator's Ed25519 signing key in a file.
// A key file is PEM-encoded PKCS #8 that only its owner can read, because anyone who reads it can sign as the operator.
// NOTE: On Windows the package neither sets nor checks who can read a key file.
package keyfile
