// Package keyfile keeps an operator's signing key in a file.
//
// The key is the Ed25519 private key an operator signs terms receipts with, and so the operator's identity: whoever
// can read the file can sign as the operator. A key file is PEM-encoded PKCS #8, the form OpenSSL and most other
// tools read and write, and is readable by its owner alone.
//
// "Its owner alone" is the file's permission bits. Windows keeps access in lists instead, which the package neither
// sets nor checks: there a key file is as open as the directory it is in.
package keyfile
