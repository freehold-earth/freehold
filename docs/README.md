# PCI Documentation

Design documents for Personal Context Infrastructure (PCI) - a five-layer architecture for data sovereignty.

## Concepts

| Document | Description |
|----------|-------------|
| [Manifesto](concepts/manifesto.md) | Vision and philosophy |
| [Executive Brief](concepts/executive-brief.md) | Business summary |
| [Trust Registry](concepts/trust-registry.md) | Prover registry design |
| [Identity](concepts/identity.md) | DID implementation (did:key) |
| [Identity Privacy Model](concepts/identity-privacy-model.md) | Privacy-preserving identity linking |

## Architecture

| Document | Description |
|----------|-------------|
| [Technical Manifesto](architecture/technical-manifesto.md) | Technical overview |
| [Technical Appendix](architecture/technical-appendix.md) | Implementation details |
| [Diagrams](architecture/diagrams.md) | Visual architecture |
| [Encryption Spec](architecture/encryption-spec.md) | AES-256-GCM interoperability spec |

## Decisions

Architecture Decision Records (ADRs) documenting key technical choices.

| Decision | Description |
|----------|-------------|
| [001 - CRDT Framework Selection](decisions/001-crdt-framework-selection.md) | Choice of Yjs for local-first sync |
| [002 - Transaction Cost Management](decisions/002-transaction-cost-management.md) | Off-chain payment channels |
| [003 - Blockchain and ZKP Stack Selection](decisions/003-blockchain-zkp-stack-selection.md) | Cardano (L3) + Midnight (L4) |
| [004 - Infrastructure Philosophy](decisions/004-infrastructure-philosophy.md) | Distributed community infrastructure over hyperscalers |
| [005 - Cardano L1 vs Midnight Sidechain for ZKP](decisions/005-cardano-l1-vs-midnight-sidechain-for-zkp.md) | When to run a verifier on Cardano L1 vs Midnight |
| [006 - pci-agent Runtime Targets and the Mobile Story](decisions/006-pci-agent-runtime-targets-and-mobile-story.md) | Desktop/server for pci-agent; thin-client mobile now, native on-device deferred |

## Key Technical Sections

### S-PAL (Sovereign Privacy & Access Language)
- [S-PAL Specification](architecture/technical-appendix.md#s-pal-specification)
- [S-PAL Negotiation Protocol](architecture/technical-appendix.md#s-pal-negotiation-protocol)

### Data Protection
- [Data Retention Enforcement](architecture/technical-appendix.md#data-retention-enforcement) - Cryptographic time-locks, on-chain audit trails, threshold decryption, economic incentives
- [Security Considerations](architecture/technical-appendix.md#security-considerations)

### Trust & Identity
- [Trust Registry](concepts/trust-registry.md) - On-chain prover registry
- [DID Implementation](architecture/technical-appendix.md#did-implementation)
- [Identity Package](concepts/identity.md) - W3C DID implementation details
- [Identity Privacy Model](concepts/identity-privacy-model.md) - Authorization records, Midnight shielded funding

### Implementation
- [Context Store](architecture/technical-appendix.md#layer-1-context-store)
- [Personal Agent](architecture/technical-appendix.md#layer-2-personal-agent)
- [Sovereignty Layer](architecture/technical-appendix.md#layer-3-sovereignty-layer)
- [Trust Bridge (ZKP)](architecture/technical-appendix.md#layer-4-trust-bridge)

## Related Repositories

- [pci-demo](https://github.com/peteski22/pci-demo) - Interactive demo application
- [pci-agent](https://github.com/peteski22/pci-agent) - Coordination service
- [pci-zkp](https://github.com/peteski22/pci-zkp) - Zero-knowledge proof service
- [pci-contracts](https://github.com/peteski22/pci-contracts) - Aiken smart contracts
- [pci-context-store](https://github.com/peteski22/pci-context-store) - Encrypted local storage
- [pci-identity](https://github.com/peteski22/pci-identity) - W3C DID implementation (did:key, ephemeral DIDs)
- [pci-infra](https://github.com/peteski22/pci-infra) - Infrastructure orchestration for development and testing
- [pci-spec](https://github.com/peteski22/pci-spec) - S-PAL schema, protocol specs, OpenAPI
