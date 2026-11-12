// Package schemas embeds the test vectors of the Freehold specification, so that Go code can check itself against
// the same files every other implementation reads.
//
// The vectors are the specification's, not this package's: they live beside this file and are written by the
// specification's own tooling. Embedding them builds them into the test binary, so a test finds them wherever it
// runs and a vector file that moves or goes missing fails the build, not one test at run time.
package schemas
