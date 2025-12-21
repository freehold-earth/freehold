#!/bin/bash
set -e

echo "═══════════════════════════════════════════════════════════"
echo "  S-PAL Contract Deployment"
echo "═══════════════════════════════════════════════════════════"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default to devnet if not specified
NETWORK="${CARDANO_NETWORK:-devnet}"

case "$NETWORK" in
  devnet)
    echo "Target: Local Yaci devnet"
    echo ""

    # Check if Yaci is accessible
    if ! curl -sf http://localhost:8080/api/v1/blocks/latest > /dev/null 2>&1; then
      echo "❌ Yaci devnet not accessible at localhost:8080"
      echo "   Start with: cd pci-demo && docker compose up -d"
      exit 1
    fi

    # Run the TypeScript deployment script
    echo "Running deployment..."
    cd "$PROJECT_ROOT/pci-contracts"
    pnpm deploy:devnet
    ;;

  preview|preprod)
    echo "Target: $NETWORK testnet"
    echo ""
    echo "⚠️  Testnet deployment requires:"
    echo "   - BLOCKFROST_API_KEY environment variable"
    echo "   - Funded wallet seed phrase"
    echo ""
    echo "Not yet implemented. Use pci-contracts directly:"
    echo "   cd pci-contracts && pnpm deploy:testnet"
    exit 1
    ;;

  mainnet)
    echo "❌ Mainnet deployment not supported via this script"
    echo "   Use proper deployment procedures for production"
    exit 1
    ;;

  *)
    echo "❌ Unknown network: $NETWORK"
    echo "   Supported: devnet, preview, preprod"
    exit 1
    ;;
esac
