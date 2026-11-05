#!/bin/bash
set -e

echo "🚀 Freehold Infrastructure Setup"
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
    # The shell wins over .env for compose, so honour an exported value first.
    profiles=${COMPOSE_PROFILES-$(sed -n 's/^COMPOSE_PROFILES=//p' .env | tail -n 1)}
    backend=${FREEHOLD_LLM_BACKEND-$(sed -n 's/^FREEHOLD_LLM_BACKEND=//p' .env | tail -n 1)}
    case ",${profiles}," in
        *,llm,*) llm_profile=yes ;;
        *) llm_profile=no ;;
    esac
    if [ "$llm_profile" = no ] && [ "$backend" != ollama ]; then
        echo ""
        echo "⚠️  llama-server is not enabled. The agent defaults to it, but the service only"
        echo "   starts when COMPOSE_PROFILES includes llm (see configs/example.env). Add it,"
        echo "   or set FREEHOLD_LLM_BACKEND=ollama to use Ollama on the host instead."
    fi
fi

# llama-server API key: one file for the server, the same value in .env for the agent
key_file=${LLAMA_API_KEY_FILE:-secrets/llama-api-key}
if [ ! -f "$key_file" ]; then
    mkdir -p "$(dirname "$key_file")"
    (umask 077; openssl rand -hex 32 > "$key_file")
    echo "✓ Generated llama-server API key at $key_file"
fi
if ! grep -q '^FREEHOLD_OPENAI_API_KEY=.' .env; then
    { grep -v '^#*FREEHOLD_OPENAI_API_KEY=' .env || true; } > .env.tmp && mv .env.tmp .env
    echo "FREEHOLD_OPENAI_API_KEY=$(cat "$key_file")" >> .env
    echo "✓ Set FREEHOLD_OPENAI_API_KEY in .env"
fi

# Create models directory
if [ ! -d models ]; then
    mkdir -p models
    echo "✓ Created models directory"
fi
if ! ls models/*.gguf >/dev/null 2>&1; then
    echo ""
    echo "📥 llama-server loads MODEL_FILE from models/; download the default with:"
    echo "   wget -P models/ https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf"
fi

# Pull base images
echo ""
echo "Pulling base images..."
docker pull node:22-alpine
docker pull python:3.12-slim

# Build services
echo ""
echo "Building Freehold services..."
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
