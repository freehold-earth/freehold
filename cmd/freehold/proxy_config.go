package main

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"

	"github.com/freehold-earth/freehold/internal/spal"
)

// The values the terms setting of a proxy's configuration may have.
const (
	// termsOptional serves a data-carrying request made without terms as plain MCP.
	termsOptional = "optional"

	// termsRequired serves no data-carrying request made without terms.
	termsRequired = "required"
)

// toleranceTable is the name of the table of a proxy's configuration that holds the operator's tolerance.
const toleranceTable = "tolerance"

// toleranceKeys are the keys the tolerance table must have. None has a default: an operator states each limit.
var toleranceKeys = []string{"custody", "retention_min_seconds", "training", "aggregation", "resale"}

// proxyFile is the configuration of the proxy command, as its file writes it.
type proxyFile struct {
	// Listen is the address the proxy listens on.
	Listen string `toml:"listen"`

	// Upstream is the URL of the MCP server the proxy stands in front of.
	Upstream string `toml:"upstream"`

	// KeyFile is the path of the operator's signing key.
	KeyFile string `toml:"key_file"`

	// AuditFile is the path of the operator's audit record.
	AuditFile string `toml:"audit_file"`

	// Terms is whether the operator serves data-carrying requests made without terms: required or optional.
	Terms string `toml:"terms"`

	// MaxBodyBytes is the largest request, and the largest single response message, the proxy reads. Zero leaves
	// the proxy's own default.
	MaxBodyBytes int64 `toml:"max_body_bytes"`

	// Tolerance is the strictest terms the operator serves under.
	Tolerance toleranceFile `toml:"tolerance"`
}

// proxySettings is a proxy's configuration, read and found usable.
type proxySettings struct {
	// auditFile is the path of the operator's audit record.
	auditFile string

	// keyFile is the path of the operator's signing key.
	keyFile string

	// listen is the address the proxy listens on.
	listen string

	// maxBodyBytes is the largest request, and the largest single response message, the proxy reads, or zero for
	// the proxy's own default.
	maxBodyBytes int64

	// termsRequired is whether the operator serves no data-carrying request made without terms.
	termsRequired bool

	// tolerance is the strictest terms the operator serves under.
	tolerance spal.Tolerance

	// upstream is the address of the MCP server the proxy stands in front of.
	upstream *url.URL
}

// toleranceFile is an operator's tolerance, as a configuration file writes it.
type toleranceFile struct {
	// Custody is the custody level the operator runs at.
	Custody spal.Custody `toml:"custody"`

	// RetentionMinSeconds is the shortest time the operator is able to keep what it is sent for. It is signed so
	// that a time below zero is read as written, and can be reported.
	RetentionMinSeconds int64 `toml:"retention_min_seconds"`

	// Training is the least the terms must permit by way of training.
	Training spal.Training `toml:"training"`

	// Aggregation is the least the terms must permit by way of aggregation.
	Aggregation spal.Aggregation `toml:"aggregation"`

	// Resale is the least the terms must permit by way of resale.
	Resale spal.Resale `toml:"resale"`
}

// pathFrom returns path as it is where it is absolute or empty, and otherwise as a path from dir.
func pathFrom(dir string, path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}

	return filepath.Join(dir, path)
}

// readProxyFile reads the configuration file at path. A path in the file that is not absolute is taken from the
// directory the file is in.
//
// It returns an error for a file that cannot be read, that is not TOML, that has a key the configuration does not
// have, or whose tolerance leaves a limit unstated.
func readProxyFile(path string) (proxyFile, error) {
	var file proxyFile
	meta, err := toml.DecodeFile(path, &file)
	if err != nil {
		return proxyFile{}, fmt.Errorf("reading the configuration: %w", err)
	}

	// A key the proxy does not know is most likely one that was misspelled, and a limit that was meant and never
	// applied is worse than a proxy that does not start.
	if unknown := meta.Undecoded(); len(unknown) > 0 {
		names := make([]string, len(unknown))
		for i, key := range unknown {
			names[i] = key.String()
		}

		return proxyFile{}, fmt.Errorf(
			"reading the configuration: %s has keys the configuration does not: %s",
			path,
			strings.Join(names, ", "),
		)
	}
	for _, key := range toleranceKeys {
		if !meta.IsDefined(toleranceTable, key) {
			return proxyFile{}, fmt.Errorf(
				"reading the configuration: %s does not state %s.%s",
				path,
				toleranceTable,
				key,
			)
		}
	}

	dir := filepath.Dir(path)
	file.KeyFile = pathFrom(dir, file.KeyFile)
	file.AuditFile = pathFrom(dir, file.AuditFile)

	return file, nil
}

// settings returns the configuration the file holds, once every part of it is found usable. It reports every part
// that is not.
func (f proxyFile) settings() (proxySettings, error) {
	settings := proxySettings{
		auditFile:    f.AuditFile,
		keyFile:      f.KeyFile,
		listen:       f.Listen,
		maxBodyBytes: f.MaxBodyBytes,
		tolerance: spal.Tolerance{
			Custody:     f.Tolerance.Custody,
			Training:    f.Tolerance.Training,
			Aggregation: f.Tolerance.Aggregation,
			Resale:      f.Tolerance.Resale,
		},
	}
	var errs []error

	if f.Listen == "" {
		errs = append(errs, errors.New("listen is not set"))
	}
	if f.KeyFile == "" {
		errs = append(errs, errors.New("key_file is not set"))
	}
	if f.AuditFile == "" {
		errs = append(errs, errors.New("audit_file is not set"))
	}
	if f.MaxBodyBytes < 0 {
		errs = append(errs, errors.New("max_body_bytes is below zero"))
	}

	switch f.Terms {
	case termsRequired:
		settings.termsRequired = true
	case termsOptional:
	case "":
		errs = append(errs, fmt.Errorf("terms is not set, and must be %s or %s", termsRequired, termsOptional))
	default:
		errs = append(errs, fmt.Errorf("terms is '%s', and must be %s or %s", f.Terms, termsRequired, termsOptional))
	}

	upstream, err := url.Parse(f.Upstream)
	switch {
	case err != nil || upstream.Host == "" || (upstream.Scheme != "http" && upstream.Scheme != "https"):
		errs = append(errs, errors.New("upstream is not an http or https URL"))
	case upstream.User != nil:
		// The proxy sends the upstream no credentials, so ones written here would be believed and never used.
		errs = append(errs, errors.New("upstream names a user or a password, and the proxy passes on neither"))
	}
	settings.upstream = upstream

	if f.Tolerance.RetentionMinSeconds < 0 {
		errs = append(errs, fmt.Errorf("%s: retention_min_seconds is below zero", toleranceTable))
	} else {
		settings.tolerance.RetentionMinSeconds = uint64(f.Tolerance.RetentionMinSeconds)
	}
	if err := settings.tolerance.Validate(); err != nil {
		errs = append(errs, fmt.Errorf("%s: %w", toleranceTable, err))
	}

	if len(errs) > 0 {
		return proxySettings{}, fmt.Errorf("the configuration is not usable: %w", errors.Join(errs...))
	}

	return settings, nil
}
