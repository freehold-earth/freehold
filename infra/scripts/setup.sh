#!/bin/bash
set -e

echo "🚀 PCI Infrastructure Setup"
echo "==========================="

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose v2 is not installed."
    exit 1
fi

echo "✓ Docker and Docker Compose found"

# Create .env if not exists
if [ ! -f .env ]; then
    echo "Creating .env from example..."
    cp configs/example.env .env
    echo "✓ Created .env - please review and customize"
else
    echo "✓ .env already exists"
fi

# Create models directory
if [ ! -d models ]; then
    mkdir -p models
    echo "✓ Created models directory"
    echo ""
    echo "📥 To use local LLM, download a model:"
    echo "   wget -P models/ https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf"
fi

# Pull base images
echo ""
echo "Pulling base images..."
docker pull node:22-alpine
docker pull python:3.12-slim

# Build services
echo ""
echo "Building PCI services..."
docker compose build

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Review and edit .env"
echo "  2. (Optional) Download an LLM model to ./models/"
echo "  3. Run: docker compose up"
echo ""
echo "For development with hot reload:"
echo "  docker compose -f docker-compose.yml -f docker-compose.dev.yml up"
