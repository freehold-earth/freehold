# Freehold Infrastructure

Infrastructure orchestration for Freehold development and testing.

This project integrates with the Midnight Network.

## Overview

This repo provides:

- **Full-stack orchestration** - Run all Freehold services together
- **Development environment** - Hot reload, debugging, local testing
- **Blockchain nodes** - Cardano and Midnight network configuration (Ledger 8.1.0)
- **Deployment scripts** - Contract deployment and setup utilities

## Quick Start

```bash
# First time setup
./scripts/setup.sh

# Start full stack
docker compose up

# Start with blockchain nodes (resource intensive)
docker compose --profile with-nodes up
```

## Architecture

```mermaid
flowchart TB
    subgraph Infra["Freehold Infrastructure"]
        subgraph Core["Core Services"]
            CS["Context Store<br/>:8081"]
            AG["Agent (Python)<br/>:8082"]
            LS["llama-server<br/>:8090 (host) / :8080 (network)"]
            ZK["ZKP Service<br/>:8084"]
        end

        NET["Internal Network"]

        CS --> NET
        AG --> NET
        AG --> LS
        ZK --> NET

        subgraph Optional["Optional Nodes"]
            CN["Cardano Node"]
            MN["Midnight Node"]
        end

        NET --> CN
        NET --> MN
    end
```

## Services

| Service | Port | Image | Description |
|---------|------|-------|-------------|
| context-store | 8081 | (built locally) | Layer 1: Encrypted vault API |
| agent | 8082 | (built locally) | Layer 2: Personal agent API |
| llama-server | 8090 | `ghcr.io/ggml-org/llama.cpp:server-b12063` | Layer 2: default LLM runtime, OpenAI-compatible API over one GGUF file (ADR-006) |
| zkp | 8084 | (built locally) | Layer 4: Zero-knowledge proof service |
| midnight-proof-server | 6300 | `midnightntwrk/proof-server:8.1.0` | ZK proof generation (required for zkp) |
| cardano-node | 3001 | `ghcr.io/intersectmbo/cardano-node:10.4.0` | Cardano preview testnet (optional) |
| midnight-node | 9944 | `midnightntwrk/midnight-node:1.0.1` | Midnight node (Ledger 8.1.0, optional) |
| midnight-indexer | 8088 | `midnightntwrk/indexer-standalone:4.3.3` | Midnight indexer with bundled SQLite storage (optional) |

## Profiles

```bash
# Core services only (lightweight)
docker compose up

# With Cardano preview testnet node
docker compose --profile cardano-testnet up

# With Midnight standalone (node + indexer for local testing)
docker compose --profile with-midnight up

# Full stack with all nodes
docker compose --profile with-nodes up

# Standalone mode (isolated Midnight environment)
docker compose --profile standalone up

# Development mode (hot reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

## Configuration

Copy the example env file and customize:

```bash
cp configs/example.env .env
```

Key settings:
- `CARDANO_NETWORK` - preview (default), preprod, or mainnet
- `MIDNIGHT_NETWORK` - preprod (default), preview, or mainnet
- `MIDNIGHT_INDEXER_URL` - Midnight indexer GraphQL endpoint (`/api/v4/graphql`)
- `MIDNIGHT_NODE_URL` - Midnight node RPC endpoint
- `INDEXER_SECRET` - Hex-encoded 32-byte secret required by the standalone indexer 4.x
- `INDEXER_BLOCKFROST_ID` - Blockfrost API key for the standalone indexer's SPO component (placeholder OK for local dev)
- `MODELS_DIR` - Host directory of GGUF model files, mounted into llama-server at `/models`
- `MODEL_FILE` - GGUF file inside `MODELS_DIR` that llama-server loads
- `LLM_CONTEXT_LENGTH` - Context window llama-server starts with (default 4096)
- `LLAMA_SERVER_PORT` - Host port for llama-server, bound to loopback only (default 8090; 8080 is the Cardano devnet API on the host)
- `COMPOSE_PROFILES` - `llm` (default) starts llama-server; empty leaves it out
- `FREEHOLD_LLM_BACKEND` - `openai` (llama-server, default) or `ollama`; with `ollama`, run the daemon on the host and point `FREEHOLD_OLLAMA_URL` at it
- `FREEHOLD_LLM_TIER` - `small` (default in compose) or `default`; names the model the agent asks for, which llama-server answers with whatever file it loaded
- `LOG_LEVEL` - debug, info, warn, error

### Midnight Network Endpoints

| Network | Indexer | Node | Faucet |
|---------|--------|------|--------|
| Preprod | `https://indexer.preprod.midnight.network/api/v4/graphql` | `https://rpc.preprod.midnight.network` | `https://faucet.preprod.midnight.network` |
| Preview | `https://indexer.preview.midnight.network/api/v4/graphql` | `https://rpc.preview.midnight.network` | - |
| Local | `http://127.0.0.1:8088/api/v4/graphql` | `http://127.0.0.1:9944` | - |

> Indexer 4.x still serves `/api/v3` as an alias for backwards compatibility;
> new work should target `/api/v4`. Verified against the Ledger 8.1.0 compatibility
> matrix at <https://docs.midnight.network/relnotes/support-matrix>.

## Scripts

| Script | Purpose |
|--------|---------|
| `setup.sh` | First-time setup, pull images, create volumes |
| `start.sh` | Start services with health checks |
| `stop.sh` | Graceful shutdown |
| `deploy-contracts.sh` | Deploy S-PAL contracts to testnet |
| `logs.sh` | Aggregate logs from all services |

## Development

### Building locally

```bash
# Build all services
docker compose build

# Build specific service
docker compose build agent
```

### Running tests

```bash
# Run integration tests
./scripts/test.sh

# Test specific service
docker compose run --rm agent pytest
```

### Viewing logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f agent
```

## Directory Structure

```
infra/
├── docker-compose.yml          # Main orchestration
├── docker-compose.dev.yml      # Development overrides
├── services/
│   ├── cardano/                # Cardano node config
│   │   └── config/
│   └── midnight/               # Midnight node config
│       └── config/
├── scripts/
│   ├── setup.sh
│   ├── start.sh
│   ├── stop.sh
│   └── deploy-contracts.sh
└── configs/
    └── example.env
```

### LLM runtime

The stack runs `llama-server` by default (ADR-006): no outbound calls, one GGUF file, the OpenAI-compatible API on `http://llama-server:8080/v1` inside the network. Put a GGUF file in `MODELS_DIR` and name it in `MODEL_FILE`; `setup.sh` prints a download command for the default. The agent waits for llama-server's health check, which passes once the model has loaded.

llama-server is on the `llm` compose profile, which `example.env` enables by default through `COMPOSE_PROFILES=llm`. To use Ollama instead, run it on the host and set `COMPOSE_PROFILES=` (empty) and `FREEHOLD_LLM_BACKEND=ollama` in `.env`; the agent then starts without llama-server and talks to `http://host.docker.internal:11434`.

## Requirements

- Docker 24+
- Docker Compose v2
- 8GB RAM minimum (16GB+ recommended with blockchain nodes)
- 50GB disk space (for blockchain data)

## License

Apache 2.0
