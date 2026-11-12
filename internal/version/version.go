// Package version exposes build metadata that is injected at link time.
//
// The variables below are set by the Makefile via -ldflags -X, using their
// fully qualified path (e.g. github.com/freehold-earth/freehold/internal/version.version).
// Renaming or moving them requires updating LDFLAGS in the Makefile.
package version

import "fmt"

var (
	// commit is the full hash of the commit the binary was built from.
	commit = "unknown"

	// date is when the binary was built, in UTC as RFC 3339.
	date = "unknown"

	// version is the release the binary was built as, or "dev" for a build outside the Makefile.
	version = "dev"
)

// String returns a single-line description of the build,
// e.g. "v0.1.0 (3f9c2a1...), built 2026-11-12T18:41:38Z".
func String() string {
	return fmt.Sprintf("%s (%s), built %s", version, commit, date)
}
