# PCI Specification

S-PAL schema, protocol specifications, and documentation for Personal Context Infrastructure.

## Overview

This repository contains the core specifications for PCI:

- **S-PAL (Sovereign Privacy & Access Language)** - Machine-readable privacy policies with cryptographic enforcement
- **Protocol definitions** - Negotiation and federation protocols
- **API specifications** - OpenAPI specs for PCI components

## Structure

```
schemas/
└── spal/
    └── v1.0/
        ├── schema.json       # JSON Schema for S-PAL policies
        └── examples/         # Example policies

protocols/
├── negotiation.md            # S-PAL negotiation protocol
└── federation.md             # Community federation protocol

api/
└── openapi/
    └── agent-api.yaml        # Personal Agent API spec

docs/
└── architecture.md           # High-level architecture overview
```

## S-PAL Quick Reference

S-PAL policies define:
- `context_scope` - Which data subset to access
- `identity_linkage` - Ephemeral DID requirements
- `proof_requirement` - Zero-knowledge proof claims
- `derivative_use` - Training/aggregation permissions
- `data_retention` - Cryptographic deletion timing
- `payment_protocol` - x402 micropayment requirements

## Related Repositories

- [pci-context-store](https://github.com/peteski22/pci-context-store) - Layer 1: Encrypted vault
- [pci-agent](https://github.com/peteski22/pci-agent) - Layer 2: Local AI agent
- [pci-contracts](https://github.com/peteski22/pci-contracts) - Layer 3: Smart contracts
- [pci-zkp](https://github.com/peteski22/pci-zkp) - Layer 4: Zero-knowledge proofs

## License

Apache 2.0
