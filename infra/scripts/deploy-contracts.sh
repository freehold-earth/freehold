#!/bin/bash
set -e

echo "📜 Deploying S-PAL contracts to Cardano testnet"
echo "================================================"

# Check if Cardano node is running
if ! docker compose ps cardano-node | grep -q "running"; then
    echo "❌ Cardano node is not running."
    echo "   Start with: docker compose --profile with-cardano up -d"
    exit 1
fi

# Build contracts if needed
echo "Building contracts..."
docker compose run --rm -T contracts pnpm compile

# Deploy
echo "Deploying to ${CARDANO_NETWORK:-preview} testnet..."

# TODO: Implement actual deployment using cardano-cli or similar
# This would:
# 1. Read compiled Plutus scripts from pci-contracts/plutus/
# 2. Build transaction with script deployment
# 3. Submit to testnet
# 4. Output script addresses

echo ""
echo "⚠️  Contract deployment not yet implemented"
echo "   See pci-contracts for manual deployment instructions"
