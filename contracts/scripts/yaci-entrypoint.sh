#!/bin/bash
# Auto-start yaci devnet node
# The create-node command runs in foreground and manages all processes

echo "Creating and starting Cardano devnet..."
exec /app/yaci-cli create-node -o --start
