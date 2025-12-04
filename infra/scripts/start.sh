#!/bin/bash
set -e

PROFILE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --with-cardano)
            PROFILE="--profile with-cardano"
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
