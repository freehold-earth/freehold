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
├── spal/
│   └── v1.0/
│       ├── schema.json       # JSON Schema for S-PAL policies
│       └── examples/         # Example policies
└── encoding/
    └── v1.0/
        └── test-vectors.json # Canonical preimage encoding test vectors

protocols/
├── negotiation.md            # S-PAL negotiation protocol
├── federation.md             # Community federation protocol
└── preimage-encoding.md      # Canonical injective, domain-separated encoding

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

## Canonical Preimage Encoding

Every signed or committed multi-field preimage in PCI — S-PAL commitments, ZK
public inputs, DID-signed request envelopes — uses a single injective,
domain-separated encoding so that distinct field tuples can never collide to the
same bytes. The rule, the domain-separator registry, the per-structure field
lists, and adversarial test vectors are in
[`protocols/preimage-encoding.md`](protocols/preimage-encoding.md). Downstream
repositories implement against it.

A dependency-free Python reference implementation lives in
[`src/pci_preimage`](src/pci_preimage): the canonical encoder, a round-trip
decoder that re-derives the field tuple for every vector, and the generator
that produces
[`schemas/encoding/v1.0/test-vectors.json`](schemas/encoding/v1.0/test-vectors.json)
— so the vectors are reproducible rather than trusted. Run the conformance
suite with `uv run pytest`; regenerate the vectors with
`uv run python -m pci_preimage.generate_vectors`.

## Related Repositories

- [pci-context-store](https://github.com/peteski22/pci-context-store) - Layer 1: Encrypted vault
- [pci-agent](https://github.com/peteski22/pci-agent) - Layer 2: Local AI agent
- [pci-contracts](https://github.com/peteski22/pci-contracts) - Layer 3: Smart contracts
- [pci-zkp](https://github.com/peteski22/pci-zkp) - Layer 4: Zero-knowledge proofs

## License

Apache 2.0
