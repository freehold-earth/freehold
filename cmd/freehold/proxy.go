package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/freehold-earth/freehold/internal/audit"
	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/keyfile"
	"github.com/freehold-earth/freehold/internal/proxy"
)

// The flags of the proxy command.
const (
	// flagAuditFile overrides the configuration's audit_file.
	flagAuditFile = "audit-file"

	// flagConfig names the configuration file.
	flagConfig = "config"

	// flagKeyFile overrides the configuration's key_file.
	flagKeyFile = "key-file"

	// flagListen overrides the configuration's listen.
	flagListen = "listen"

	// flagUpstream overrides the configuration's upstream.
	flagUpstream = "upstream"
)

// The time limits of the proxy's server.
const (
	// idleTimeout is how long a connection may stay open with no request on it.
	idleTimeout = 2 * time.Minute

	// readHeaderTimeout is how long a client may take to send the headers of a request.
	readHeaderTimeout = 10 * time.Second

	// readTimeout is how long a client may take to send a whole request, headers and body.
	// It does not limit the time a response takes.
	readTimeout = 30 * time.Second

	// shutdownGrace is how long in-flight requests have to finish after the proxy is told to stop.
	shutdownGrace = 5 * time.Second
)

// isLoopback reports whether address names this machine.
func isLoopback(address *url.URL) bool {
	host := address.Hostname()
	ip := net.ParseIP(host)

	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// newProxyCmd creates the proxy command, which answers for an operator in front of its MCP server.
func newProxyCmd() *cobra.Command {
	proxyCmd := &cobra.Command{
		Use:   "proxy",
		Short: "Answer for an operator in front of its MCP server",
		Long: "Stand in front of an operator's MCP server and answer for the operator under the terms extension, " +
			"earth.freehold/spal.\n\n" +
			"For each request an end-user's agent makes under terms, the proxy checks the terms against the " +
			"operator's tolerance and refuses the request or passes it on. A request it passes on carries what the " +
			"operator has committed to, in _meta[\"earth.freehold/commitment\"], and its result goes back with a " +
			"receipt signed with the operator's key. Every step is written to the operator's audit record.\n\n" +
			"The proxy holds the operator to account. It does not make the server behind it keep the commitment: " +
			"that server has to read the commitment and honor it.\n\n" +
			"The proxy speaks plain HTTP. Put it behind whatever ends TLS for the operator.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			settings, err := proxySettingsFrom(cmd)
			if err != nil {
				return err
			}
			logger := slog.New(slog.NewTextHandler(cmd.ErrOrStderr(), nil))

			return runProxy(cmd.Context(), settings, logger, func(address net.Addr, operatorDID string) error {
				_, err := fmt.Fprintf(cmd.OutOrStdout(), "listening on %s as %s\n", address, operatorDID)

				return err
			})
		},
	}

	flags := proxyCmd.Flags()
	flags.String(flagConfig, "", "the configuration file (TOML), which must be named")
	flags.String(flagListen, "", "the address to listen on, in place of the configuration's listen")
	flags.String(flagUpstream, "", "the URL of the MCP server behind, in place of the configuration's upstream")
	flags.String(flagKeyFile, "", "the operator's signing key, in place of the configuration's key_file")
	flags.String(flagAuditFile, "", "the operator's audit record, in place of the configuration's audit_file")

	return proxyCmd
}

// proxySettingsFrom returns the proxy's settings from the configuration file that cmd names.
// A flag that was given replaces the file's value.
func proxySettingsFrom(cmd *cobra.Command) (proxySettings, error) {
	flags := cmd.Flags()
	path, err := flags.GetString(flagConfig)
	if err != nil {
		return proxySettings{}, err
	}
	if path == "" {
		return proxySettings{}, fmt.Errorf("--%s is not set", flagConfig)
	}

	file, err := readProxyFile(path)
	if err != nil {
		return proxySettings{}, err
	}
	for _, override := range []struct {
		flag  string
		value *string
	}{
		{flag: flagListen, value: &file.Listen},
		{flag: flagUpstream, value: &file.Upstream},
		{flag: flagKeyFile, value: &file.KeyFile},
		{flag: flagAuditFile, value: &file.AuditFile},
	} {
		if !flags.Changed(override.flag) {
			continue
		}
		if *override.value, err = flags.GetString(override.flag); err != nil {
			return proxySettings{}, err
		}
	}

	return file.settings()
}

// runProxy runs the proxy that settings describes until ctx is done, then lets in-flight requests finish.
// It calls listening with the address and the operator's DID once the proxy is listening.
func runProxy(
	ctx context.Context,
	settings proxySettings,
	logger *slog.Logger,
	listening func(address net.Addr, operatorDID string) error,
) (err error) {
	key, err := keyfile.Read(settings.keyFile)
	if err != nil {
		return err
	}
	// The assertion is safe: Public returns an ed25519.PublicKey for the key Read returned.
	operatorDID, err := didkey.FromPublicKey(key.Public().(ed25519.PublicKey))
	if err != nil {
		return err
	}

	record, err := audit.Open(settings.auditFile)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, record.Close()) }()

	handler, err := proxy.New(proxy.Config{
		Audit:         record,
		Key:           key,
		Logger:        logger,
		MaxBodyBytes:  settings.maxBodyBytes,
		TermsRequired: settings.termsRequired,
		Tolerance:     settings.tolerance,
		Upstream:      settings.upstream,
	})
	if err != nil {
		return err
	}

	var listen net.ListenConfig
	listener, err := listen.Listen(ctx, "tcp", settings.listen)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", settings.listen, err)
	}

	logger.InfoContext(ctx, "the proxy is listening",
		"address", listener.Addr().String(),
		"operator_did", operatorDID,
		"upstream", settings.upstream.String(),
		"terms_required", settings.termsRequired,
		"custody", settings.tolerance.Custody,
		"retention_min_seconds", settings.tolerance.RetentionMinSeconds,
		"training", settings.tolerance.Training,
		"aggregation", settings.tolerance.Aggregation,
		"resale", settings.tolerance.Resale,
	)
	if settings.upstream.Scheme == "http" && !isLoopback(settings.upstream) {
		logger.WarnContext(ctx, "the upstream is plain http on another machine: "+
			"what end-users send will travel to it in the clear", "upstream", settings.upstream.String())
	}
	if err := listening(listener.Addr(), operatorDID); err != nil {
		return errors.Join(fmt.Errorf("saying where the proxy listens: %w", err), listener.Close())
	}

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	return serve(ctx, server, listener, shutdownGrace)
}

// serve answers requests on listener with server until ctx is done.
// It then stops accepting requests, waits up to grace for in-flight requests, and closes the connections still open.
func serve(ctx context.Context, server *http.Server, listener net.Listener, grace time.Duration) error {
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()

	select {
	case err := <-stopped:
		return fmt.Errorf("serving: %w", err)
	case <-ctx.Done():
	}

	// ctx is already done, so the grace period runs on a context that ignores its cancellation.
	finishing, cancel := context.WithTimeout(context.WithoutCancel(ctx), grace)
	defer cancel()
	if err := server.Shutdown(finishing); err != nil {
		if !errors.Is(err, context.DeadlineExceeded) {
			return errors.Join(fmt.Errorf("stopping: %w", err), server.Close())
		}
		if err := server.Close(); err != nil {
			return fmt.Errorf("stopping: %w", err)
		}
	}

	return nil
}
