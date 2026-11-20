package main

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/freehold-earth/freehold/internal/spal"
)

// testTolerance is the [tolerance] table of a configuration that states every limit.
const testTolerance = `[tolerance]
custody = "federated_operator"
retention_min_seconds = 0
training = "forbidden"
aggregation = "forbidden"
resale = "forbidden"
`

func TestProxyFile_Settings(t *testing.T) {
	tests := map[string]struct {
		change  func(*proxyFile)
		wantErr string
	}{
		"terms that are neither required nor optional": {
			change:  func(f *proxyFile) { f.Terms = "sometimes" },
			wantErr: "the configuration is not usable: terms is 'sometimes', and must be required or optional",
		},
		"terms that are not set": {
			change:  func(f *proxyFile) { f.Terms = "" },
			wantErr: "the configuration is not usable: terms is not set, and must be required or optional",
		},
		"an upstream that is not a URL": {
			change:  func(f *proxyFile) { f.Upstream = "://nowhere" },
			wantErr: "the configuration is not usable: upstream is not an http or https URL",
		},
		"an upstream that is not http": {
			change:  func(f *proxyFile) { f.Upstream = "ftp://127.0.0.1:9000" },
			wantErr: "the configuration is not usable: upstream is not an http or https URL",
		},
		"an upstream with no host": {
			change:  func(f *proxyFile) { f.Upstream = "http://" },
			wantErr: "the configuration is not usable: upstream is not an http or https URL",
		},
		"an upstream with a password": {
			change: func(f *proxyFile) { f.Upstream = "https://operator:secret@mcp.example" },
			wantErr: "the configuration is not usable: " +
				"upstream names a user or a password, and the proxy passes on neither",
		},
		"no listen": {
			change:  func(f *proxyFile) { f.Listen = "" },
			wantErr: "the configuration is not usable: listen is not set",
		},
		"no key_file": {
			change:  func(f *proxyFile) { f.KeyFile = "" },
			wantErr: "the configuration is not usable: key_file is not set",
		},
		"no audit_file": {
			change:  func(f *proxyFile) { f.AuditFile = "" },
			wantErr: "the configuration is not usable: audit_file is not set",
		},
		"a max_body_bytes below zero": {
			change:  func(f *proxyFile) { f.MaxBodyBytes = -1 },
			wantErr: "the configuration is not usable: max_body_bytes is below zero",
		},
		"a tolerance with a value S-PAL does not have": {
			change:  func(f *proxyFile) { f.Tolerance.Custody = "nowhere" },
			wantErr: "the configuration is not usable: tolerance: not a value S-PAL allows: custody is 'nowhere'",
		},
		"a retention below zero": {
			change:  func(f *proxyFile) { f.Tolerance.RetentionMinSeconds = -1 },
			wantErr: "the configuration is not usable: tolerance: retention_min_seconds is below zero",
		},
		"every unusable part is reported": {
			change: func(f *proxyFile) {
				f.Listen = ""
				f.KeyFile = ""
				f.Terms = "sometimes"
			},
			wantErr: "the configuration is not usable: listen is not set\n" +
				"key_file is not set\n" +
				"terms is 'sometimes', and must be required or optional",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			file := proxyFile{
				Listen:    "127.0.0.1:8080",
				Upstream:  "http://127.0.0.1:9000",
				KeyFile:   "/etc/freehold/operator.pem",
				AuditFile: "/var/lib/freehold/audit.jsonl",
				Terms:     "required",
				Tolerance: toleranceFile{
					Custody:     spal.CustodyFederatedOperator,
					Training:    spal.TrainingForbidden,
					Aggregation: spal.AggregationForbidden,
					Resale:      spal.ResaleForbidden,
				},
			}
			tc.change(&file)

			_, err := file.settings()
			require.EqualError(t, err, tc.wantErr)
		})
	}
}

func TestReadProxyFile(t *testing.T) {
	path := filepath.Join("testdata", "proxy.toml")

	file, err := readProxyFile(path)
	require.NoError(t, err)
	require.Equal(t, proxyFile{
		Listen:    "127.0.0.1:8080",
		Upstream:  "http://127.0.0.1:9000",
		KeyFile:   filepath.Join("testdata", "operator.pem"),
		AuditFile: filepath.Join("testdata", "audit.jsonl"),
		Terms:     "required",
		Tolerance: toleranceFile{
			Custody:     spal.CustodyFederatedOperator,
			Training:    spal.TrainingForbidden,
			Aggregation: spal.AggregationForbidden,
			Resale:      spal.ResaleForbidden,
		},
	}, file)

	settings, err := file.settings()
	require.NoError(t, err)
	require.Equal(t, proxySettings{
		auditFile:     filepath.Join("testdata", "audit.jsonl"),
		keyFile:       filepath.Join("testdata", "operator.pem"),
		listen:        "127.0.0.1:8080",
		termsRequired: true,
		tolerance: spal.Tolerance{
			Custody:     spal.CustodyFederatedOperator,
			Training:    spal.TrainingForbidden,
			Aggregation: spal.AggregationForbidden,
			Resale:      spal.ResaleForbidden,
		},
		upstream: &url.URL{Scheme: "http", Host: "127.0.0.1:9000"},
	}, settings)
}

func TestReadProxyFile_Paths(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "proxy.toml")
	absolute := filepath.Join(dir, "elsewhere", "operator.pem")
	content := "key_file = '" + absolute + "'\naudit_file = 'records/audit.jsonl'\n" + testTolerance
	require.NoError(t, os.WriteFile(path, []byte(content), 0o600))

	file, err := readProxyFile(path)
	require.NoError(t, err)
	require.Equal(t, absolute, file.KeyFile)
	require.Equal(t, filepath.Join(dir, "records", "audit.jsonl"), file.AuditFile)
}

func TestReadProxyFile_Refuses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proxy.toml")

	tests := map[string]struct {
		content string
		wantErr string
	}{
		"a key the configuration does not have": {
			content: "listen = '127.0.0.1:8080'\nupstreem = 'http://127.0.0.1:9000'\n" + testTolerance,
			wantErr: "reading the configuration: " + path + " has keys the configuration does not: upstreem",
		},
		"keys the configuration does not have, in the tolerance too": {
			content: "upstreem = 'http://127.0.0.1:9000'\n" + testTolerance + "retention_max_seconds = 5\n",
			wantErr: "reading the configuration: " + path +
				" has keys the configuration does not: upstreem, tolerance.retention_max_seconds",
		},
		"no tolerance": {
			content: "listen = '127.0.0.1:8080'\n",
			wantErr: "reading the configuration: " + path + " does not state tolerance.custody",
		},
		"a tolerance that leaves a limit unstated": {
			content: "[tolerance]\ncustody = 'federated_operator'\nretention_min_seconds = 0\n" +
				"training = 'forbidden'\naggregation = 'forbidden'\n",
			wantErr: "reading the configuration: " + path + " does not state tolerance.resale",
		},
		"a value S-PAL does not have": {
			content: "[tolerance]\ncustody = 'nowhere'\n",
			wantErr: "reading the configuration: toml: line 2 (last key \"tolerance.custody\"): " +
				"not a value S-PAL allows: custody is 'nowhere'",
		},
		"a value of the wrong kind": {
			content: "listen = 8080\n",
			wantErr: "reading the configuration: toml: line 1 (last key \"listen\"): " +
				"incompatible types: TOML value has type int64; destination has type string",
		},
		"not TOML": {
			content: "{\"listen\": \"127.0.0.1:8080\"}",
			wantErr: "reading the configuration: toml: line 1: expected '.' or '=', but got '{' instead",
		},
	}

	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			require.NoError(t, os.WriteFile(path, []byte(tc.content), 0o600))

			_, err := readProxyFile(path)
			require.EqualError(t, err, tc.wantErr)
		})
	}

	t.Run("a file that is not there", func(t *testing.T) {
		_, err := readProxyFile(filepath.Join(t.TempDir(), "proxy.toml"))
		require.ErrorIs(t, err, os.ErrNotExist)
	})
}
