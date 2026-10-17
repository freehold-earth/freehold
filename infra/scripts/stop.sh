#!/bin/bash

echo "🛑 Stopping Freehold services..."

docker compose --profile with-nodes down

echo "✓ All services stopped"
