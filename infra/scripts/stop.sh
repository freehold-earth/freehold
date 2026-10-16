#!/bin/bash

echo "🛑 Stopping PCI services..."

docker compose --profile with-nodes down

echo "✓ All services stopped"
