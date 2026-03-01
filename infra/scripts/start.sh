#!/bin/bash
set -e

PROFILE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --help|-h)
            echo "Usage: start.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --with-cardano    Start with Cardano preview testnet node"
            echo "  --with-midnight   Start with Midnight local node + indexer"
            echo "  --with-nodes      Start with all blockchain nodes"
            echo "  --standalone      Isolated Midnight environment (node + indexer)"
            echo "  --dev             Development mode with hot reload"
            echo "  -h, --help        Show this help message"
            echo ""
            echo "Environment: copy configs/example.env to .env and customize."
            exit 0
            ;;
        --with-cardano)
            PROFILE="--profile cardano-testnet"
            shift
            ;;
        --with-midnight)
            PROFILE="--profile with-midnight"
            shift
            ;;
        --with-nodes)
            PROFILE="--profile with-nodes"
            shift
            ;;
        --standalone)
            PROFILE="--profile standalone"
            shift
            ;;
        --dev)
            DEV="-f docker-compose.yml -f docker-compose.dev.yml"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "🚀 Starting PCI services..."

if [ -n "$DEV" ]; then
    echo "   Mode: Development (hot reload)"
    docker compose $DEV $PROFILE up
else
    echo "   Mode: Production"
    docker compose $PROFILE up -d

    echo ""
    echo "Services starting in background. View logs with:"
    echo "  docker compose logs -f"
    echo ""
    echo "Stop with:"
    echo "  ./scripts/stop.sh"
fi
