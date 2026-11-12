// Command freehold is the Freehold command line tool.
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/freehold-earth/freehold/internal/version"
)

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

	return rootCmd
}

// main is the entrypoint for the CLI.
func main() {
	if err := newRootCmd().Execute(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
