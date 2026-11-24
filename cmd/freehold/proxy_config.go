package main

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"

	"github.com/BurntSushi/toml"

	"github.com/freehold-earth/freehold/internal/spal"
)

// The values the terms setting of a proxy's configuration may have.
const (
	// termsOptional means a data-carrying request made without terms is served as plain MCP.
	termsOptional = "optional"

	// termsRequired means no data-carrying request made without terms is served.
	termsRequired = "required"
)

// toleranceTable is the name of the table of a proxy's configuration that holds the operator's tolerance.
const toleranceTable = "tolerance"

// toleranceKeys lists the keys the tolerance table must have, in the order they are reported.
// None has a default.
var toleranceKeys = []string{"custody", "retention_min_seconds", "training", "aggregation", "resale"}

// proxyFile is the configuration of the proxy command as its file states it.
type proxyFile struct {
	// AuditFile is the path of the operator's audit record.
	AuditFile string `toml:"audit_file"`

	// KeyFile is the path of the operator's signing key.
	KeyFile string `toml:"key_file"`

	// Listen is the address the proxy listens on.
	Listen string `toml:"listen"`

	// MaxBodyBytes is the size limit of a request and of a single response message.
	// Zero selects the proxy's default.
	MaxBodyBytes int64 `toml:"max_body_bytes"`

	// Terms states whether a data-carrying request must carry terms, and is required or optional.
	Terms string `toml:"terms"`

	// Tolerance is the strictest terms the operator serves under.
	Tolerance toleranceFile `toml:"tolerance"`

	// Upstream is the URL of the MCP server the proxy forwards to.
	Upstream string `toml:"upstream"`
}

// proxySettings is a proxy's validated configuration.
type proxySettings struct {
	// auditFile is the path of the operator's audit record.
	auditFile string

	// keyFile is the path of the operator's signing key.
	keyFile string

	// listen is the address the proxy listens on.
	listen string

	// maxBodyBytes is the size limit of a request and of a single response message, or zero for the proxy's default.
	maxBodyBytes int64

	// termsRequired is true when the operator serves no data-carrying request made without terms.
	termsRequired bool

	// tolerance is the strictest terms the operator serves under.
	tolerance spal.Tolerance

	// upstream is the URL of the MCP server the proxy forwards to.
	upstream *url.URL
}

// toleranceFile is an operator's tolerance as a configuration file states it.
type toleranceFile struct {
	// Aggregation is the least the terms must permit for aggregation.
	Aggregation spal.Aggregation `toml:"aggregation"`

	// Custody is the custody level the operator runs at.
	Custody spal.Custody `toml:"custody"`

	// Resale is the least the terms must permit for resale.
	Resale spal.Resale `toml:"resale"`

	// RetentionMinSeconds is the shortest time the operator is able to keep what it is sent.
	// It is signed so that a value below zero is read and reported.
	RetentionMinSeconds int64 `toml:"retention_min_seconds"`

	// Training is the least the terms must permit for training.
	Training spal.Training `toml:"training"`
}

// pathFrom returns path unchanged when it is absolute or empty, and joined to dir otherwise.
func pathFrom(dir string, path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}

	return filepath.Join(dir, path)
}

// readProxyFile reads the configuration file at path.
// A relative path in the file is resolved against the directory of the file.
// It returns an error that names every unknown key and every tolerance limit the file leaves unstated.
func readProxyFile(path string) (proxyFile, error) {
	var file proxyFile
	meta, err := toml.DecodeFile(path, &file)
	if err != nil {
		return proxyFile{}, fmt.Errorf("reading the configuration: %w", err)
	}

	// An unknown key is likely a misspelled one, and starting without the limit it meant is worse than not starting.
	var errs []error
	for _, key := range meta.Undecoded() {
		errs = append(errs, fmt.Errorf("the configuration has no key named %s", key))
	}
	for _, key := range toleranceKeys {
		if !meta.IsDefined(toleranceTable, key) {
			errs = append(errs, fmt.Errorf("%s.%s is not stated", toleranceTable, key))
		}
	}
	if len(errs) > 0 {
		return proxyFile{}, fmt.Errorf("reading the configuration at %s: %w", path, errors.Join(errs...))
	}

	dir := filepath.Dir(path)
	file.KeyFile = pathFrom(dir, file.KeyFile)
	file.AuditFile = pathFrom(dir, file.AuditFile)

	return file, nil
}

// settings returns the validated configuration that the file holds.
// The error names every part that is not usable.
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
		// The proxy sends the upstream no credentials, so credentials in the URL would never be used.
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
