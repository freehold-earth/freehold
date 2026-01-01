# ADR-003: Blockchain and ZKP Stack Selection

**Status:** Accepted
**Date:** 2025-12-30
**Decision:** Use Cardano for smart contract enforcement (Layer 3) and Midnight for zero-knowledge proofs (Layer 4)

## Context

PCI requires two blockchain-related capabilities:

1. **Smart Contract Enforcement** - Cryptographically enforce S-PAL policies, record access commitments, handle disputes
2. **Zero-Knowledge Proofs** - Verify claims (age, credentials, attributes) without revealing underlying data

Selecting the wrong stack creates risks: high transaction costs kill adoption, immature tooling slows development, ecosystem decline leaves the project stranded.

## Decision

### Layer 3: Cardano

**Primary reasons:**

| Feature | Benefit for PCI |
|---------|-----------------|
| **Deterministic fees** | Know transaction cost before submitting. Users can budget accurately. No gas auction surprises. |
| **eUTxO model** | Transactions are deterministic and parallelizable. What you simulate locally is what executes on-chain. |
| **Formal verification heritage** | Plutus is based on Haskell. Aiken compiles to Plutus Core. Both amenable to formal proofs - critical for policy enforcement. |
| **Proof-of-Stake** | ~0.5 TWh/year vs Bitcoin's ~120 TWh. Neutralizes "crypto is environmentally destructive" criticism. A transaction uses less energy than a Google search. |
| **TypeScript tooling** | Lucid provides excellent TypeScript integration. Matches PCI's developer accessibility goals (TypeScript-first). |

**Language choice: Aiken over Plutus/Helios**

We chose Aiken (Rust-like syntax) for validators because:
- More familiar to mainstream developers than Haskell
- Strong type system catches errors at compile time
- Active development and good documentation
- Compiles to same Plutus Core as raw Plutus

### Layer 4: Midnight

**Primary reasons:**

| Feature | Benefit for PCI |
|---------|-----------------|
| **Privacy with compliance** | ZKPs that can satisfy regulatory requirements. Prove attributes without revealing data, while maintaining audit capability when legally required. |
| **IOG alignment** | Same team building Cardano. Aligned roadmaps, shared infrastructure vision, coordinated releases. |
| **Compact language** | Purpose-built for ZK circuits. Abstracts away cryptographic complexity. |
| **TypeScript SDK** | First-class TypeScript support matches PCI's developer accessibility goals. |
| **Cardano settlement** | Uses Cardano for finality, creating natural integration point with Layer 3. |

## Alternatives Considered

### Ethereum

**Pros:**
- Largest developer ecosystem
- Most dApps and tooling
- Battle-tested over years

**Cons:**
- Gas price volatility makes costs unpredictable
- MEV (Maximal Extractable Value) creates front-running risks
- Congestion during high demand
- Account model less suited to our deterministic policy enforcement

**Verdict:** Ecosystem size doesn't outweigh operational unpredictability.

### Solana

**Pros:**
- High throughput (~65,000 TPS theoretical)
- Low transaction costs
- Growing ecosystem

**Cons:**
- Multiple network outages raise reliability concerns
- More centralized validator set
- Less emphasis on formal verification
- Rust-only development (limits accessibility)

**Verdict:** Speed is less important than reliability and verifiability for policy enforcement.

### Polygon / zkSync / StarkNet

**Pros:**
- Ethereum L2s with lower costs
- Native ZK capabilities (zkSync, StarkNet)
- Growing ecosystems

**Cons:**
- ZK tooling still maturing
- Multiple competing standards
- Dependency on Ethereum base layer
- Less integration with purpose-built privacy solutions like Midnight

**Verdict:** Could work, but Midnight's dedicated privacy focus and Cardano integration is more aligned.

### Zcash / Monero

**Pros:**
- Proven privacy technology
- Years of production use

**Cons:**
- Privacy-only chains, no smart contract capability
- Can't enforce S-PAL policies on-chain
- Regulatory concerns in some jurisdictions

**Verdict:** Wrong tool for the job - we need programmable policies, not just private transfers.

## Cost and Ecosystem Considerations

### Transaction Costs Matter

See [ADR-002: Transaction Cost Management](./002-transaction-cost-management.md) for detailed analysis.

Key points:
- Cardano minimum fee ~0.17 ADA
- At current prices (~$0.90/ADA), that's ~$0.15 per transaction
- Micropayments require off-chain channels with periodic settlement
- Deterministic fees allow accurate cost modeling

### Ecosystem Health Affects Sustainability

| Concern | Mitigation |
|---------|------------|
| ADA price decline reduces developer interest | Architecture isolates chain-specific code; Layers 1-2 are fully portable |
| Midnight delays or pivots | ZKP interfaces are abstracted; could integrate alternative ZK solutions |
| IOG changes priorities | Open-source codebase; community can maintain |
| Smaller ecosystem than Ethereum | Focus on quality over quantity; PCI doesn't need every possible integration |

### Portability by Design

PCI's layered architecture provides insurance:

```
Layer 1 (Context Store)  - Pure TypeScript, no chain dependency
Layer 2 (Agent)          - Python, no chain dependency
Layer 3 (Contracts)      - Cardano-specific, but isolated
Layer 4 (ZKP)            - Midnight-specific, but abstracted behind interfaces
Layer 5 (Identity)       - DID standards, chain-agnostic
```

If ecosystem conditions change dramatically, Layers 3-4 could theoretically be ported. The S-PAL specification itself is chain-agnostic.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| ADA price volatility affects transaction costs | High | Medium | Off-chain channels, batching, USD-denominated thresholds |
| Midnight delays beyond current timeline | Medium | Medium | Core privacy features work with mocked proofs; upgrade when ready |
| Cardano ecosystem shrinks significantly | Low | High | Layered architecture allows porting; S-PAL is chain-agnostic |
| IOG abandons either project | Very Low | High | Both are open-source; communities can maintain |
| Regulatory action against privacy features | Medium | High | Midnight designed for compliance; "privacy with accountability" model |

## Consequences

### Positive

- Deterministic costs enable accurate user pricing
- Formal verification heritage aligns with policy enforcement needs
- IOG alignment means coordinated development across L3/L4
- TypeScript tooling matches developer accessibility goals
- Energy efficiency neutralizes environmental criticism

### Negative

- Smaller developer pool than Ethereum
- Less third-party tooling and integrations
- Midnight still maturing (testnet phase)
- Learning curve for Aiken/Compact languages
- Dependency on IOG's continued commitment

## References

- [ADR-002: Transaction Cost Management](./002-transaction-cost-management.md)
- [Cardano Documentation](https://docs.cardano.org/)
- [Midnight Documentation](https://docs.midnight.network/)
- [Aiken Language](https://aiken-lang.org/)
- [Lucid - Cardano TypeScript SDK](https://lucid.spacebudz.io/)
- [PCI Manifesto - Technology Choices](../concepts/manifesto.md)
