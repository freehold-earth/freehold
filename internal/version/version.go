package version

import "fmt"

// The linker sets these by name (-ldflags -X), so their names and their package path are part of the build's
// contract.
var (
	// commit is the full hash of the commit the binary was built from.
	commit = "unknown"

	// date is when the binary was built, in UTC as RFC 3339.
	date = "unknown"

	// version is the release the binary was built as, or "dev" when none was injected.
	version = "dev"
)

// String returns a single-line description of the build,
// e.g. "v0.1.0 (3f9c2a1...), built 2026-11-12T18:41:38Z".
func String() string {
	return fmt.Sprintf("%s (%s), built %s", version, commit, date)
}
