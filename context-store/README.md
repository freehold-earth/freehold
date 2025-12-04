# PCI Context Store

Layer 1: Encrypted local-first data storage with CRDT sync for Personal Context Infrastructure.

## Overview

The Context Store provides:

- **Encrypted Vaults** - AES-256-GCM encryption at rest
- **CRDT Sync** - Conflict-free replication across devices
- **Vector Embeddings** - Semantic search over personal context
- **Local-First** - Data stays on your devices

## Installation

```bash
pnpm add pci-context-store
```

## Quick Start

```typescript
import { ContextStore, Vault } from "pci-context-store";

// Initialize the context store
const store = new ContextStore({
  encryption: {
    algorithm: "aes-256-gcm",
  },
});

// Create a vault for health data
const healthVault = await store.createVault("health");

// Store encrypted data
await healthVault.put("allergies", {
  items: ["penicillin", "peanuts"],
  lastUpdated: new Date(),
});

// Retrieve and decrypt
const allergies = await healthVault.get("allergies");
```

## Architecture

```mermaid
flowchart TB
    subgraph Store["Context Store"]
        subgraph Vaults["Vaults"]
            HV["Health Vault"]
            FV["Financial Vault"]
            CV["Custom Vaults"]
        end

        EL["Encryption Layer"]

        HV --> EL
        FV --> EL
        CV --> EL

        subgraph Services["Services"]
            SE["Sync Engine"]
            VE["Vector Embedding"]
            IS["Index Store"]
        end

        EL --> SE
        EL --> VE
        EL --> IS
    end
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build

# Type check
pnpm lint
```

## Related Packages

- [pci-spec](https://github.com/peteski22/pci-spec) - S-PAL schema and protocols
- [pci-agent](https://github.com/peteski22/pci-agent) - Layer 2: Personal Agent
- [pci-contracts](https://github.com/peteski22/pci-contracts) - Layer 3: Smart Contracts
- [pci-zkp](https://github.com/peteski22/pci-zkp) - Layer 4: Zero-Knowledge Proofs

## License

Apache 2.0
