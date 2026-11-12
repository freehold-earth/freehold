.DEFAULT_GOAL := help

MODULE := $(shell go list -m)

# The Go packages. Named one by one because ./... would also walk
# node_modules, where some npm packages ship Go files. spec/ holds the
# package that embeds the specification's test vectors.
PACKAGES := ./cmd/... ./internal/... ./spec/...

# Version string, from git. Other parts of this repository tag their own
# releases (spec-v0.3.0, zkp-v0.4.0), so only freehold-v* tags count here:
#   - "freehold-v1.0.0"              on a tag
#   - "freehold-v0.1.0-2-gabcdef1"   2 commits past tag freehold-v0.1.0
#   - "abcdef1-dirty"                no such tag, uncommitted changes
#   - "dev"                          git unavailable or no commits
VERSION := $(shell git describe --tags --match 'freehold-v*' --always --dirty 2>/dev/null || echo "dev")
COMMIT  := $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")
DATE    := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

# Inject build metadata into internal/version. The -X target is the fully
# qualified package path plus the variable name; it must match that package.
LDFLAGS := -s -w \
	-X '$(MODULE)/internal/version.version=$(VERSION)' \
	-X '$(MODULE)/internal/version.commit=$(COMMIT)' \
	-X '$(MODULE)/internal/version.date=$(DATE)'

BUILDFLAGS := -trimpath

GOLANGCI_LINT_VERSION := $(shell cat .golangci-lint-version 2>/dev/null)

.PHONY: help
help:
	@echo "freehold - the Freehold command line tool (Go)"
	@echo ""
	@echo "  make build   Build bin/freehold"
	@echo "  make lint    Run golangci-lint (applies fixes, see .golangci.yml)"
	@echo "  make test    Run the Go tests with the race detector"
	@echo ""
	@echo "The TypeScript, Python and Aiken parts build from their own directories."

.PHONY: build
build:
	@echo "building (version: $(VERSION), commit: $(COMMIT))..."
	@go build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o bin/freehold ./cmd/freehold

.PHONY: lint
lint:
	@test -n "$(GOLANGCI_LINT_VERSION)" || (echo "missing .golangci-lint-version"; exit 1)
	@test "$$(golangci-lint version --short)" = "$(GOLANGCI_LINT_VERSION)" || (echo "golangci-lint $(GOLANGCI_LINT_VERSION) required"; exit 1)
	@golangci-lint run $(PACKAGES)

.PHONY: test
test:
	@go test -race $(PACKAGES)
