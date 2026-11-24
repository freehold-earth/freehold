package main

import (
	"crypto/ed25519"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/freehold-earth/freehold/internal/didkey"
	"github.com/freehold-earth/freehold/internal/keyfile"
)

// newKeyNewCmd creates the key new command, which makes an operator's signing key and prints its identifier.
func newKeyNewCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "new <file>",
		Short: "Make a new signing key and print its did:key identifier",
		Long: "Make a new Ed25519 signing key, write it to <file> for its owner alone to read, and print the " +
			"did:key identifier to give to the end-users whose agents will call this operator.\n\n" +
			"The file is never written over. Whoever holds it can sign as the operator, and a key that is lost " +
			"cannot be made again, so keep it safe and keep a copy.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			// args[0] is safe: ExactArgs(1) guarantees len(args) == 1.
			key, err := keyfile.Create(args[0])
			if err != nil {
				return err
			}

			// The assertion is safe: Public returns an ed25519.PublicKey for the key Create made.
			did, err := didkey.FromPublicKey(key.Public().(ed25519.PublicKey))
			if err != nil {
				return err
			}

			if _, err := fmt.Fprintln(cmd.OutOrStdout(), did); err != nil {
				// The key cannot be made again, so the error names its file and its identifier.
				return fmt.Errorf(
					"the key is in %s and its identifier is %s, but printing it failed: %w",
					args[0],
					did,
					err,
				)
			}

			return nil
		},
	}
}
