// Command freehold is the Freehold command line tool.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/freehold-earth/freehold/internal/version"
)

// main is the entrypoint for the CLI.
func main() {
	// An interrupt or a request to terminate ends the context, so that a command that runs until told to stop
	// stops in its own time. The first one is the only one waited on: a second ends the process at once.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	context.AfterFunc(ctx, stop)
	err := newRootCmd().ExecuteContext(ctx)
	stop()
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

// newRootCmd creates the root command for the freehold CLI with all subcommands attached.
func newRootCmd() *cobra.Command {
	rootCmd := &cobra.Command{
		Use:           "freehold",
		Short:         "freehold runs the operator side of Freehold",
		Long:          "freehold runs the operator side of Freehold: the pieces that hold a node to the terms a person set.",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	// Print "freehold <version>" rather than cobra's default "freehold version <version>".
	rootCmd.SetVersionTemplate("{{.Name}} {{.Version}}\n")
	rootCmd.Version = version.String()

	rootCmd.AddCommand(newKeyCmd())
	rootCmd.AddCommand(newProxyCmd())

	return rootCmd
}
