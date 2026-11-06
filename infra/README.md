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
# First time setup: writes .env and generates llama-server's API key and
# certificate. Compose refuses to start without them, so run this before anything else.
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

Every port below is published on loopback only (`127.0.0.1`), since Docker-published ports bypass host firewalls such as ufw. Other services reach each other by service name on the compose network; put a gateway in front for anything that must be reachable from outside.

| Service | Port | Image | Description |
|---------|------|-------|-------------|
| context-store | 8081 | (built locally) | Layer 1: Encrypted vault API |
| agent | 8082 | (built locally) | Layer 2: Personal agent API |
| llama-server | 8090 | `ghcr.io/ggml-org/llama.cpp:server-b12063` | Layer 2: default LLM runtime, chat-completions API over one GGUF file, TLS with its own certificate (ADR-006) |
| zkp | 8084 | (built locally) | Layer 4: Zero-knowledge proof service |
| midnight-proof-server | 6300 | `midnightntwrk/proof-server:8.1.0` | ZK proof generation (required for zkp) |
| cardano-node | (none) | `ghcr.io/intersectmbo/cardano-node:10.4.0` | Cardano preview testnet (optional) |
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
- `FREEHOLD_LLM_API_KEY` - Bearer token llama-server requires; `setup.sh` generates `secrets/llama-api-key` for the server and writes the same value here. `LLAMA_SECRETS_DIR` moves the key and the certificate together (relative to this directory; `setup.sh` reads it from the shell or from `.env`, as compose does)
- `FREEHOLD_LLM_CA_FILE` - The certificate the agent trusts for the model server; llama-server's by default. Set it empty for an Ollama proxy with a publicly trusted certificate
- `FREEHOLD_LLM_BACKEND` - `http` (llama-server, default) or `ollama`; with `ollama`, run the daemon on the host behind a TLS proxy and set `FREEHOLD_LLM_URL` to the proxy's `https://` address. The agent refuses a plain `http://` model server
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

The stack runs `llama-server` by default (ADR-006): no outbound calls, one GGUF file, the chat-completions API on `https://llama-server:8080/v1` inside the network. Put a GGUF file in `MODELS_DIR` and name it in `MODEL_FILE`; `setup.sh` prints a download command for the default while `models/` holds no GGUF file. The agent waits for llama-server's health check, which passes once the model has loaded.

llama-server serves TLS with the certificate `setup.sh` writes to `secrets/llama-server.crt` (and the key beside it), named for `llama-server`, `localhost` and `127.0.0.1` and valid for 825 days; the agent trusts it through `FREEHOLD_LLM_CA_FILE`. To rotate it, delete the two files, run `setup.sh` again, and restart the stack, since a running container keeps the certificate it was started with. From the host, local tools use the same certificate:

```bash
curl --cacert secrets/llama-server.crt -H "Authorization: Bearer $(cat secrets/llama-api-key)" https://127.0.0.1:8090/v1/models
```

llama-server is on the `llm` compose profile, which `example.env` enables by default through `COMPOSE_PROFILES=llm`. To use Ollama instead, run it on the host behind a TLS proxy, and set `COMPOSE_PROFILES=` (empty), `FREEHOLD_LLM_BACKEND=ollama` and `FREEHOLD_LLM_URL` to the proxy's `https://` address in `.env`; the agent then starts without llama-server. A proxy with a publicly trusted certificate needs `FREEHOLD_LLM_CA_FILE=` (empty) so the agent uses the system store. A proxy with a private certificate needs that certificate inside the agent's container: `FREEHOLD_LLM_CA_FILE` is a path in the container, so mount the file with a compose override and name it there:

```yaml
# docker-compose.override.yml
services:
  agent:
    volumes:
      - /path/to/proxy-ca.crt:/run/proxy-ca.crt:ro
    environment:
      - FREEHOLD_LLM_CA_FILE=/run/proxy-ca.crt
```

A `.env` written before this profile existed has no `COMPOSE_PROFILES` line, so llama-server never starts while the agent still expects it. Add `COMPOSE_PROFILES=llm` (or switch to Ollama as above); `setup.sh` warns when it finds such a file.

## Requirements

- Docker 24+
- Docker Compose v2
- 16GB RAM runs this stack as shipped: it loads a small GGUF (Phi-3-mini, about 2.3 GB) so it starts anywhere; the agent's own `small` Ollama tier is a different model, Phi-4-mini. A 27B-class model, the tier ADR-004 sizes a family node for, needs a 32 GB box; put its GGUF file in `MODELS_DIR` and name it in `MODEL_FILE`
- 50GB disk space for the local devnet's chain data; a mainnet relay's storage is sized in ADR-004

## License

Apache 2.0
