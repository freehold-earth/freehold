package main

import "github.com/spf13/cobra"

// newKeyCmd creates the key command, which groups the commands for an operator's signing key.
func newKeyCmd() *cobra.Command {
	keyCmd := &cobra.Command{
		Use:   "key",
		Short: "Manage the key an operator signs with",
		Long: "Manage the key an operator signs terms receipts with. The key is the operator's identity: " +
			"end-users' agents know the operator by the did:key identifier of its public half.",
	}

	keyCmd.AddCommand(newKeyNewCmd())

	return keyCmd
}
