// Package version exposes build metadata that is injected at link time.
//
// The variables below are set by the Makefile via -ldflags -X, using their
// fully qualified path (e.g. github.com/freehold-earth/freehold/internal/version.version).
// Renaming or moving them requires updating LDFLAGS in the Makefile.
package version
