# ADR-005: Cardano L1 vs Midnight Sidechain for ZKP

**Status:** Proposed
**Date:** 2026-07-16
**Decision:** Keep Midnight as the primary ZKP execution surface for PCI, and document Cardano L1 as a legitimate alternative for verifiers that fit inside a single Cardano transaction budget

## Context

[ADR-003](./003-blockchain-zkp-stack-selection.md) selected Midnight as PCI's zero-knowledge execution surface, on the basis that Cardano L1 had no native pairing operations and that a shielded, Compact-native environment was the only realistic place to run programmable ZK circuits with Cardano-flavoured settlement.

Since ADR-003 was written, two things changed. Cardano exposed the BLS12-381 pairing operations as Plutus V3 built-ins under CIP-381, and a public reference deployment showed those built-ins are strong enough to run a real Groth16 verifier inside a single on-chain script. The [`CharlesHoskinson/proof-zk-recovery`](https://github.com/CharlesHoskinson/proof-zk-recovery) repository documents a Plutus V3 validator on the Cardano preview testnet that verifies a 3,450,403-constraint Groth16 proof, folds a BSB22 Pedersen commitment into the public input, and releases funds — all in one transaction, at 3,914,957,868 ExCPU (about 39.1% of the per-transaction compute budget). The proof is 336 bytes, the on-chain verifying key is 672 bytes, and the public input is a single 32-byte field element.

The relevant point for PCI is not the wallet-recovery use case; it is the shape of the envelope. A ~3.5M-constraint Groth16 verifier fitting in ~39% of the per-transaction ExCPU budget suggests that L1 execution is in the plausible range for the verifiers PCI plans to run (age proofs, credential possession, membership in a policy set, S-PAL policy satisfaction) — but constraint count alone does not determine on-chain cost. Each candidate circuit needs its own ExCPU / ExMem / script-size / public-input measurement before it can be routed to L1. Where those numbers land inside the budget, running the verifier on L1 removes an entire operational surface (a sidechain, its indexer, DUST accounting, and any bridge back to Cardano for settlement).

This ADR resolves the resulting question: when do we reach for Midnight, and when do we reach for a Cardano-native circuit?

## Decision

Midnight remains the primary ZKP execution surface for PCI. Layer 4 continues on the Midnight track, and existing Midnight-based work (pci-zkp, the Compact circuits, midnight-js integration) is not affected.

Cardano L1 is now a documented alternative for a verifier when **all three** of the following hold:

1. The verifier fits inside a single Cardano transaction's compute budget (measured in ExCPU / ExMem, not just constraint count).
2. The proof does not need Midnight's shielded state — the public inputs, verifying key, and any datum required to reconstruct the public input are safe to expose on a public chain.
3. Avoiding the sidechain-and-bridge surface, or landing the verifier and its payout in a single atomic transaction, is worth the trusted-setup and tooling cost.

The Trust Bridge interfaces stay abstracted (as ADR-003 anticipated), so a verifier can be routed to either backend without leaking the choice into the S-PAL layer above it.

## Rationale

### When Midnight wins

- **Shielded state.** Anything where the public input itself is sensitive — private balances, private set membership where the set is confidential, credentials that must not be linkable across proofs — needs Midnight's shielding. A Cardano L1 verifier publishes its public input by construction.
- **Programmable privacy.** Compact is designed for circuits with private state and private ledger interactions. Building the same behaviour as a Plutus V3 script plus a Groth16 verifier plus an off-chain prover is materially more work, and loses the Compact abstractions.
- **Per-operation cost profile.** Midnight's DUST-metered model avoids paying a Cardano transaction fee per verification, which is the shape you want for high-frequency proof workloads. Whether that is cheaper in absolute terms will depend on DUST pricing once the Mōhalu DUST Capacity Exchange lands; the qualitative point is the fee model, not a specific crossover number (see [ADR-002](./002-transaction-cost-management.md)).
- **Developer experience.** The Compact toolchain, midnight-js, and the preview/preprod networks are the current shortest path from circuit source to a working prover. This does not go away when L1 becomes viable for a subset of verifiers.

### When Cardano L1 wins

- **One less trust boundary to operate.** No sidechain node, no separate indexer, no DUST accounting, no bridge for settlement. The verifier and its consequence (fund release, policy commitment, access grant) settle in the same transaction on the same chain.
- **Atomic verify-and-act.** Because the verifier runs inside a Plutus V3 script, the same script can gate a payout, a datum update, or a token mint on the proof succeeding. There is no window between "proof verified on Midnight" and "action taken on Cardano" for state to drift or a bridge to fail.
- **Mature Cardano tooling.** cardano-cli, Koios, Blockfrost, and CIP-30 wallets are production-grade for the transaction-shape work around a verifier. The Plutus V3 verifier itself uses CIP-381 built-ins directly, as in the proof-zk-recovery deployment (public testnet, independently verifiable, transaction hashes on-chain). Aiken support for CIP-381 pairing built-ins is a separate question — an Aiken-native path would be more ergonomic but is not proven here; see the Consequences section.
- **No bridge to trust.** Any cross-chain path from Midnight to Cardano is a trust surface. For a verifier whose entire purpose is enforcement on Cardano (paying out custody, releasing an S-PAL-locked asset, minting an audit token), keeping it on L1 removes that surface entirely.

### When neither is right today

If a workload is too large for one Cardano transaction *and* does not need Midnight's shielding, neither surface is a comfortable fit. Recursive composition, off-chain rollups of many proofs into a single on-chain verification, or waiting for Cardano's per-transaction budget to grow are all reasonable directions, but this ADR does not pick one. Workloads that hit that ceiling should be flagged and revisited rather than shoehorned.

### The public-input pattern is portable

Independent of which surface a verifier runs on, the proof-zk-recovery deployment establishes a pattern PCI should adopt: the on-chain validator reconstructs the public input from context it already trusts (datum, script parameters, redeemer components) rather than accepting a public input the prover supplied. The reference formula shape is:

```text
pub = Fr(Blake2b-256(domain_sep || scriptHash || snapshot_version
                     || root || C || entitlement || D || role))
```

Without this, a prover can present a valid Groth16 proof for a public input of their own choosing, which for policy-enforcement circuits means a prover can lie about which policy they proved. Adopting the same pattern in S-PAL is tracked as a follow-up in pci-contracts.

## Alternatives Considered

### Stay Midnight-only

**Approach:** Treat the CIP-381 built-ins as interesting but not a reason to reopen ADR-003. All ZKP work continues on Midnight.

**Pros:**
- No new toolchain (gnark, Plutus V3 verifier, CIP-381) to learn.
- Existing pci-zkp work continues without disruption.
- One ZK execution model to reason about across the codebase.

**Cons:**
- Keeps the sidechain-and-bridge operational surface for verifiers that no longer need it.
- Prevents atomic verify-and-act on Cardano, even where that is the cleanest design.
- Ignores public evidence that L1 verification at PCI-relevant circuit sizes is viable today.

**Verdict:** Rejected. The evidence is strong enough that documenting L1 as an alternative is the honest response; not documenting it would leave future contributors reinventing this analysis.

### Move everything to Cardano L1

**Approach:** Retire Midnight from the Layer 4 stack and build all PCI verifiers as Plutus V3 scripts on Cardano.

**Pros:**
- Single chain, single toolchain, single settlement model.
- Every verifier is atomic with its consequence.

**Cons:**
- Gives up shielded state entirely, which some PCI workloads (identity linking, private set membership over a confidential set) actually need.
- Requires a production-grade MPC trusted-setup ceremony for every distinct circuit — a heavy lift for a small team.
- Throws away existing pci-zkp work built on the Compact/midnight-js stack.
- Any circuit that exceeds one Cardano transaction's budget has nowhere to go.

**Verdict:** Rejected. The set of PCI verifiers is not uniformly small and not uniformly public; forcing them all onto L1 forecloses valid designs.

### Wait for Mōhalu / DUST Capacity Exchange

**Approach:** Defer the question until Midnight's Mōhalu phase (Q2–Q3 2026, DUST Capacity Exchange, SPO onboarding) changes the operational and economic story.

**Pros:**
- Avoids committing to L1 tooling before Midnight's own economics settle.
- Lets the Midnight track keep its momentum without a parallel path.

**Cons:**
- Documenting an alternative is not a commitment to build on it. Waiting to write ADR-005 does not delay Mōhalu; it just delays a decision people are already making informally.
- The pattern (reconstructing the public input from trusted context) needs to be adopted on Midnight regardless.

**Verdict:** Rejected as a substitute, accepted as a companion. Mōhalu genuinely will change some economics on Midnight, and we should revisit this ADR when it lands.

## Consequences

### Positive

- The choice of ZK surface becomes an explicit design decision, not a default.
- The public-input-reconstruction pattern is captured for both surfaces, closing a real forgery gap in the current S-PAL validator.
- Cardano-native workloads (custody release, policy-gated mints) gain an atomic path they did not have before.
- No disruption to in-flight Midnight work.

### Negative

- Team has to learn CIP-381 built-ins and Groth16 verifier construction if and when the first L1-native PCI circuit ships.
- Any L1-native Groth16 circuit needs its own MPC trusted-setup ceremony to reach a defensible 1-of-N assumption; single-operator setups are fine for dev keys but not for anything holding real value. Other proof systems (Plonk with a universal setup, Halo2 with a transparent setup) trade this cost off differently, but nothing on-chain today on Cardano uses them via CIP-381.
- Two ZK surfaces means two sets of proving-key artefacts, two sets of tooling to keep current, and a governance question about which surface a new verifier should target.
- Aiken support for CIP-381 pairing built-ins should be verified before assuming an Aiken-native L1 verifier is straightforward; the reference deployment uses Plutus V3 directly.

## References

- [ADR-002: Transaction Cost Management](./002-transaction-cost-management.md)
- [ADR-003: Blockchain and ZKP Stack Selection](./003-blockchain-zkp-stack-selection.md)
- [proof-zk-recovery reference deployment](https://github.com/CharlesHoskinson/proof-zk-recovery) — Plutus V3 Groth16 verifier on Cardano preview testnet
- [CIP-381: BLS12-381 pairing built-ins](https://cips.cardano.org/cip/CIP-0381)
- [Midnight release notes](https://docs.midnight.network/relnotes/overview)
- [gnark (Groth16 proving system in Go)](https://github.com/Consensys/gnark)
