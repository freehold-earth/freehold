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

# llama-server API key: one file for the server, the same value in .env for the agent.
# The path comes from the shell or from .env, the same two places compose reads it;
# compose strips matching quotes around a .env value, so this does too.
key_file=${LLAMA_API_KEY_FILE-$(sed -n 's/^LLAMA_API_KEY_FILE=//p' .env | tail -n 1 | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')}
key_file=${key_file:-secrets/llama-api-key}
# An empty key file makes llama-server accept every request, so one is regenerated.
if [ ! -s "$key_file" ]; then
    mkdir -p "$(dirname "$key_file")"
    (umask 077; openssl rand -hex 32 > "$key_file")
    echo "✓ Generated llama-server API key at $key_file"
fi
server_key=$(head -n 1 "$key_file")
env_key=$(sed -n 's/^FREEHOLD_LLM_API_KEY=//p' .env | tail -n 1)
if [ -z "$env_key" ]; then
    # .env holds the token, so it is readable by its owner only.
    (umask 077; { grep -v '^#*FREEHOLD_LLM_API_KEY=' .env || true; } > .env.tmp)
    echo "FREEHOLD_LLM_API_KEY=$server_key" >> .env.tmp
    mv .env.tmp .env
    echo "✓ Set FREEHOLD_LLM_API_KEY in .env"
elif [ "$env_key" != "$server_key" ]; then
    echo "✗ FREEHOLD_LLM_API_KEY in .env does not match the key in $key_file; the agent would get 401 from llama-server."
    echo "  Remove one of them and run this script again."
    exit 1
fi
chmod 600 .env

# llama-server's certificate: the agent sends prompts over this link only under
# TLS, loopback or not, so the server gets a key and a self-signed certificate
# naming it as compose and the host reach it. The agent trusts the certificate.
cert_dir=$(dirname "$key_file")
if [ ! -s "$cert_dir/llama-server.key" ] || [ ! -s "$cert_dir/llama-server.crt" ]; then
    (umask 077; openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -keyout "$cert_dir/llama-server.key" -out "$cert_dir/llama-server.crt" -days 825 \
        -subj "/CN=llama-server" \
        -addext "subjectAltName=DNS:llama-server,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1)
    echo "✓ Generated llama-server certificate at $cert_dir/llama-server.crt"
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
