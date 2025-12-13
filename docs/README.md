# PCI Documentation

Private documentation repository for Personal Context Infrastructure (PCI) design documents.

## Documents

| Document | Description |
|----------|-------------|
| [PCI Manifesto](PCI_Manifesto.md) | Vision and philosophy |
| [Technical Manifesto](PCI_Technical_Manifesto.md) | Technical overview |
| [Technical Appendix](PCI_Technical_Appendix.md) | Implementation details |
| [Architecture Diagrams](PCI_Architecture_Mermaid.md) | Visual architecture |
| [Trust Registry](PCI_Trust_Registry.md) | Prover registry design |
| [Executive Brief](PCI_Executive_Brief.md) | Business summary |




## Key Technical Sections

### S-PAL (Sovereign Privacy & Access Language)
- [S-PAL Specification](PCI_Technical_Appendix.md#s-pal-specification)
- [S-PAL Negotiation Protocol](PCI_Technical_Appendix.md#s-pal-negotiation-protocol)

### Data Protection
- [Data Retention Enforcement](PCI_Technical_Appendix.md#data-retention-enforcement) - Cryptographic time-locks, on-chain audit trails, threshold decryption, economic incentives
- [Security Considerations](PCI_Technical_Appendix.md#security-considerations)

### Trust & Identity
- [Trust Registry](PCI_Trust_Registry.md) - On-chain prover registry
- [DID Implementation](PCI_Technical_Appendix.md#did-implementation)
- [PCI Identity Package](PCI_Identity.md) - W3C DID implementation details

### Implementation
- [Context Store](PCI_Technical_Appendix.md#layer-1-context-store)
- [Personal Agent](PCI_Technical_Appendix.md#layer-2-personal-agent)
- [Sovereignty Layer](PCI_Technical_Appendix.md#layer-3-sovereignty-layer)
- [Trust Bridge (ZKP)](PCI_Technical_Appendix.md#layer-4-trust-bridge)

## Related Repositories

- **pci-demo** - Interactive demo application
- **pci-agent** - Coordination service
- **pci-zkp** - Zero-knowledge proof service
- **pci-contracts** - Aiken smart contracts
- **pci-context-store** - Encrypted local storage
- **pci-identity** - W3C DID implementation (did:key, ephemeral DIDs)
