# ADR-007: Cardano ↔ Midnight Interop Path

**Status:** Proposed
**Date:** 2026-07-22
**Decision:** PCI v1 does not depend on a Cardano ↔ Midnight asset bridge. Proof-generation capacity is obtained through the native partner-chain observation-and-designation mechanism, and value settlement stays single-chain. Generic asset bridging is deferred; when it is needed, the native partner-chain path is the target, not a third-party bridge.

## Context

[ADR-003](./003-blockchain-zkp-stack-selection.md) put Cardano at Layer 3 and Midnight at Layer 4. [ADR-005](./005-cardano-l1-vs-midnight-sidechain-for-zkp.md) established that a given verifier may run on either surface. Both left an implicit question open: when a flow touches both chains, what carries value or state between them?

That question was not concretely answerable when pci-agent was scoped in February 2026 — Midnight mainnet did not exist yet. It is answerable now, and two in-flight issues are waiting on it: [pci-zkp#11](https://github.com/peteski22/pci-zkp/issues/11) (business-pays DUST delegation) and [pci-agent#7](https://github.com/peteski22/pci-agent/issues/7) (agent-to-agent commerce).

### What the four candidate paths actually look like in July 2026

**Native partner-chain mechanism — live, and narrower than "a bridge."** DUST is not bridged. NIGHT is held on Cardano as the native asset cNIGHT, and Midnight's `pallet_cnight_observation` (the Native Token Observation Pallet) watches Cardano for cNIGHT UTXO creation and spend events against registered addresses, emitting corresponding DUST creation and destruction events so that DUST supply tracks cNIGHT movement 1:1. Registration binds a Cardano reward address to a Midnight DUST public key. No asset crosses. DUST itself is explicitly non-transferable — it is a shielded gas resource, not a token — but a NIGHT holder can *designate* the DUST their NIGHT generates to another party's DUST key, which is precisely the "developer holds NIGHT, users spend the DUST" shape.

Generic *asset* bridging over the partner-chain relationship is a separate and less mature thing. Reporting indicates the initial deployment is Cardano→Midnight only, with bidirectional movement in a later phase pending audits; this is not stated in the primary docs we could reach, and should be treated as unconfirmed.

**Wanchain — federated, shipping, and freshly exploited.** Wanchain launched cross-chain NIGHT support between Cardano and BNB Chain in December 2025 and announced a ZKP-relay bridge between Cardano and Midnight mainnets. On 21 July 2026 the Cardano↔BNB route was drained of roughly 515 million NIGHT (reported at $9–13M depending on the price point used).

The failure was Wanchain's, not either chain's, and the distinction matters. BlockSec Phalcon decompiled the on-chain Plutus V2 bytecode and traced the root cause to a non-injective signed-message encoding in Wanchain's `TreasuryCheck` validator: fourteen variable-length redeemer fields raw-concatenated via `AppendByteString` with no delimiters or length prefixes, so distinct field tuples produce identical byte strings, identical hashes, and therefore reusable signatures. An authorization for roughly 3,110 NIGHT was re-partitioned into one for more than 203 million — a 65,000× amplification with no key compromise. Cardano's ledger and consensus behaved exactly as specified; they executed a third-party validator whose own logic accepted a forged authorization. Midnight was not in the affected route at all: NIGHT is a Cardano native asset, so the Cardano↔BNB path never touches Midnight. The Midnight Foundation's statement that the incident was isolated to the Wanchain bridge holds up, and is also exactly the point — the bridge was the whole attack surface.

Two details compound this. Wanchain's bytecode already contained the `SerialiseData` builtin and used it on the output-datum matching path, just not when constructing the signature hash — the safe primitive was in hand and not applied. And the exploited route is not the route PCI would use, but it is the same operator, the same federated trust model, and the same validator codebase family, with no published postmortem or remediation timeline at the time of writing.

**Catalyst ZK-relayer — not funded.** The Fund 13 proposal "Decentralised Bridge connecting Cardano and Midnight using novel Zero Knowledge Proof relayer" requested 500,000 ADA (~$300k) for a 12-month, six-milestone build. It was **not approved** (125M yes, 55.9M abstain). It was led by Temujin Louie, Wanchain's CEO, with in-kind support from IOG's Midnight team, and named MPC as the fallback if the ZKP approach did not work out. There is no near-term path here to target.

**LayerZero — not yet.** LayerZero integration is scoped to Midnight's Hua phase, targeted Q3 2026 and later. It is unavailable today, and its value proposition is reach into Ethereum/Solana/Bitcoin rather than Cardano↔Midnight movement, which the partner-chain relationship already covers.

### What PCI actually needs

Restating the two blocked issues in terms of what has to move:

- **pci-zkp#11** needs a business to fund a user's proof generation. What must move is *capacity on Midnight*, not an asset from Cardano.
- **pci-agent#7** needs agents to pay each other. `PaymentProtocol` in `pci-agent`'s S-PAL model is already `x402 | lightning | cardano`, and `PaymentCurrency` is `sats | lovelace | usd_cents`. Every one of those settles on Cardano L1 or an off-chain rail. None of them denominate value on Midnight.

Neither requires an asset to cross from Cardano to Midnight or back.

## Decision

**PCI v1 has no Cardano ↔ Midnight bridge in its critical path.** Concretely:

1. **Proof capacity uses the native observation-and-designation mechanism.** A business holds cNIGHT on Cardano, registers, and designates the resulting DUST to the user's DUST key. This unblocks pci-zkp#11 with no bridge dependency. It is the mechanism Midnight ships today, not a roadmap item.
2. **Value settles single-chain.** Agent-to-agent payments settle on Cardano L1 or an off-chain rail (x402, Lightning) per the existing S-PAL payment model. Nothing in pci-agent#7 requires Midnight-denominated value, and nothing should be designed to.
3. **Cross-chain *state* uses proofs, not bridged assets.** Where a Cardano-side action must depend on a Midnight-side proof, ADR-005 already gives two answers — run the verifier on Cardano L1 and settle atomically, or verify on Midnight and treat the result as an attestation. Choose per verifier under ADR-005's criteria. Do not introduce a bridge to close this gap.
4. **When generic bridging does become necessary, the native partner-chain path is the target.** It is the most trust-minimised of the four and the only one whose trust assumptions PCI is already accepting elsewhere.
5. **Wanchain is ruled out as a PCI dependency.** Not deferred — ruled out. The structural objection is that a federated bridge concentrates PCI's entire cross-chain risk in one operator's quorum and one operator's application code, which is the opposite of what ADR-004 and ADR-005 spend their reasoning protecting. The 21 July incident is corroboration, not the argument. Reversing this needs a new ADR making a positive case, not a lapsed condition.

Nothing here forecloses a bridge later. It removes a bridge from the set of things v1 must be correct about.

## Rationale

### The bridge was a question we did not have to answer

The strongest argument for this decision is that the framing in pci-agent#10 — "which bridge does PCI target as v1?" — contained an assumption that does not survive contact with how Midnight actually works. DUST is generated by *observation* of Cardano state, not by moving anything. Once that is understood, the DUST delegation flow that appeared to be bridge-blocked is not blocked at all, and the payment flow was never denominated on Midnight to begin with.

Answering "which bridge" would have imported a trust surface, an operator dependency, and a liveness dependency to solve a problem PCI does not have.

### A bridge is the largest available trust surface, and PCI's whole pitch is minimising those

ADR-004 rejected hyperscaler dependency on sovereignty grounds. ADR-005 counted "one less trust boundary to operate" as a first-class benefit of Cardano L1 verification. A federated bridge is a strictly worse version of the same problem: an external quorum whose compromise is total, sitting between the user's data-sovereignty guarantees and their enforcement. Adopting one in v1 would contradict the reasoning already recorded in two prior ADRs.

The 21 July incident is evidence for this, not the cause of the decision. Had the exploit not happened, a federated bridge would still have been the largest single trust concentration in the stack.

The ecosystem's own read points the same way. Hoskinson's response to the exploit attributed it to legacy third-party bridge architecture and argued that zero-knowledge systems replacing trust in bridge operators and multisigs with cryptographic proofs are the long-term fix. That is an argument for proofs over bridged assets, which is the shape this ADR adopts — though it is corroboration of direction, not a substitute for PCI's own reasoning.

### Timing makes the choice easy rather than hard

The mechanism PCI actually needs — native observation and designation — is live today and sufficient for v1. That is the whole decision, and it does not depend on how the bridging options rank.

Among the *generic bridging* options, none is both available and acceptable: the Catalyst relayer was not funded, LayerZero is Hua-phase, native bidirectional asset movement is unconfirmed, and the one that does ship is the one carrying an active incident. Note that option 2 splits — the observation-and-designation half is live, the generic-asset-bridging half is not, and conflating them is what made this question look harder than it is. A decision that would have been a genuine trade-off six months from now is, today, mostly a matter of reading the board correctly.

### The exploit's root cause is a lesson PCI must apply to its own code

The `TreasuryCheck` failure is the same class of bug as the public-input forgery gap ADR-005 identified in S-PAL, and PCI is currently exposed to it.

An encoding is *non-injective* when two different field tuples serialize to the same bytes. Concatenating variable-length fields without boundaries does exactly this: `("alice", "bob123")` and `("aliceb", "ob123")` both yield `alicebob123`. Same bytes, same hash, so a signature over one authorizes the other. Wanchain's attacker re-partitioned fourteen such fields to turn ~3,110 NIGHT into 203M+.

ADR-005's remedy for public-input forgery was to reconstruct the public input from trusted context under a domain-separated hash:

```text
pub = Fr(Blake2b-256(domain_sep || scriptHash || snapshot_version
                     || root || C || entitlement || D || role))
```

**Domain separation and injectivity defend against different attacks.** The `domain_sep` prefix stops a commitment valid in one context being replayed in another. It does nothing about ambiguity *within* a context: if any of those eight fields are variable-length, the fields can be re-partitioned and the same forgery works. ADR-005 specifies the first property and not the second.

`domain_sep` is not exempt from this. A variable-length domain separator concatenated ahead of unprefixed fields is itself part of the ambiguity — the boundary between separator and first field can be moved like any other. Domain separation only delivers its guarantee when the separator is fixed-width or length-prefixed like everything else.

Fixed-width fields (32-byte hashes, 8-byte integers) concatenate injectively and are already safe. PCI's exposure is its variable-length identifiers — S-PAL policy IDs such as `spal:did:pci:cardano:addr1abc123:health-records`, DIDs, and the request envelopes pci-agent#7 will have agents sign.

This ADR therefore adds a requirement that outlives any bridge decision: **every signed or committed multi-field preimage in PCI — S-PAL commitments, ZKP public inputs, DID-signed request envelopes — must use an injective, domain-separated encoding**, achieved by length-prefixing every field including the domain separator, or by serializing through a self-describing format. On Cardano, the idiomatic form is hashing over `SerialiseData` (CBOR field boundaries) rather than over `AppendByteString` concatenation, which is precisely the remedy BlockSec identified and which Wanchain's own contract had available but did not apply on the signature path.

**Injectivity is a property of the encoding, not of the hash.** ADR-005's pattern uses `Blake2b-256` and BlockSec's recommendation uses `Sha3_256`; either is fine, and switching between them fixes nothing on its own. This ADR requires the encoding property and deliberately does not pick a hash — that choice belongs with the circuit and contract work, where field-element widths and on-chain costs decide it.

This ADR states the requirement and stops there. The canonical preimage schema — concrete field lists, types, widths, the domain-separator format, and test vectors — is specification work, and belongs in `pci-spec` with implementations following in `pci-contracts` (S-PAL commitments and on-chain verifiers) and `pci-agent` (DID-signed request envelopes for #7). Writing that schema into a decision record would create a second source of truth the moment the spec lands. Tracked as follow-ups against those three repositories.

### What would change this decision

This is a v1 scoping decision with explicit triggers to revisit:

- A PCI flow genuinely needs an asset denominated on Midnight (nothing currently does).
- Native bidirectional partner-chain asset movement ships and is audited — then adopt it directly, skipping the third-party question.
- Mōhalu's DUST Capacity Exchange changes how proof capacity is acquired, potentially making the designation mechanism above obsolete or merely one of several options.
- Not Wanchain. Item 5 is a standing exclusion, not a condition waiting to lapse; re-adopting it requires a superseding ADR that argues the case on its merits.
- PCI needs reach beyond Cardano (Ethereum, Solana) — that is the LayerZero conversation, and it is a different ADR.

## Alternatives Considered

### Adopt Wanchain as the v1 bridge

**Approach:** Target Wanchain's Cardano↔Midnight bridge, on the reasoning that it ships first and is Midnight-endorsed.

**Pros:**
- Earliest generic asset movement of the four options.
- Backed by the Midnight team; an obvious default.
- Would give PCI a single mechanism covering every conceivable cross-chain need, including ones not yet identified.

**Cons:**
- Federated quorum: compromise of the operator is compromise of everything PCI moves.
- Active, unremediated incident on a sibling route with no published postmortem, of a bug class that indicates a systemic review gap rather than a one-off slip — the safe primitive (`SerialiseData`) was present in the same contract and simply not used on the signature path.
- Solves a problem PCI does not have — nothing in pci-zkp#11 or pci-agent#7 needs it.
- Introduces an operator liveness dependency into user-facing flows.

**Verdict:** Rejected, and ruled out as a standing exclusion rather than a deferral. Adopting the largest available trust surface to serve no identified requirement is not a trade-off, it is an unforced error. Re-adoption requires a superseding ADR.

### Target the Catalyst ZK-relayer bridge

**Approach:** Wait for the Fund 13 ZK-relayer and design v1 around it.

**Pros:**
- A ZK-relayer is genuinely the most trust-minimised generic bridge design of the four.
- Architecturally sympathetic to PCI — proofs rather than a signing quorum.

**Cons:**
- Not funded. There is nothing to wait for.
- Was led by Wanchain's CEO, so it inherits the operator question rather than resolving it.
- The proposal named MPC as the fallback if ZKP development did not pan out, meaning the trust-minimisation was itself contingent.
- Even if refunded in a later Fund, the timeline was 12 months to production.

**Verdict:** Rejected on availability. Worth watching if a successor proposal appears in a later Fund, since the design is the right shape.

### Wait for LayerZero (Hua)

**Approach:** Defer all cross-chain design until Hua-phase LayerZero integration lands, then build once against the broadest option.

**Pros:**
- Widest ecosystem reach; unlocks Ethereum and Solana in the same stroke.
- Known, documented fee model.
- One integration rather than a Cardano-specific one now and a multi-chain one later.

**Cons:**
- Q3 2026 and later; blocks pci-zkp#11 and pci-agent#7 for an unbounded period to buy reach PCI has no current use for.
- Solves multi-chain reach, not Cardano↔Midnight movement, which the partner-chain relationship covers more directly.
- Waiting is only free if the thing being waited for is needed. It is not.

**Verdict:** Rejected as a v1 gate. Genuinely the right answer to a question PCI has not asked yet; a separate ADR when multi-chain reach becomes a requirement.

### Wait for native bidirectional partner-chain asset movement

**Approach:** Pick the native path but block v1 on bidirectional asset movement shipping.

**Pros:**
- Ends up at the same target this ADR names, with no interim mechanism to unwind.
- Most trust-minimised generic option.

**Cons:**
- Blocks two issues on a capability neither needs.
- Bidirectional timing is unconfirmed; primary docs do not commit to it.
- Conflates two separable things: the observation-and-designation mechanism (live, sufficient for PCI) and generic asset bridging (immature, unneeded).

**Verdict:** Rejected as a gate, accepted as the direction. This is the difference between "target the native path" and "wait for the native path" — this ADR does the former.

## Consequences

### Positive

- pci-zkp#11 is unblocked immediately and with no external dependency: business holds cNIGHT, registers, designates DUST.
- pci-agent#7 is unblocked with no bridge work; payments settle on rails the S-PAL model already encodes.
- PCI's cross-chain trust surface in v1 is the Cardano↔Midnight partner-chain relationship it was already trusting under ADR-003, plus nothing.
- No operator liveness dependency in user-facing flows. A bridge outage cannot take PCI down because there is no bridge.
- The injective-encoding requirement closes a real forgery gap across S-PAL, ZKP public inputs, and DID-signed envelopes — value that persists regardless of any future bridge decision.
- Deferring keeps optionality: the bridge landscape in six months will be clearer, and PCI will not have built against the wrong one.

### Negative

- Any future PCI flow that genuinely needs Midnight-denominated value will hit this decision and require a follow-up ADR. That cost is deferred, not removed.
- The cNIGHT registration flow is a real user-facing surface (Cardano reward address plus DUST public key binding) with its own UX and key-management work in pci-demo and pci-identity. "No bridge" is not "no integration."
- PCI is now dependent on the observation pallet's correctness and liveness. This is a smaller and better-audited surface than a bridge, but it is not zero, and it is a trust assumption worth naming rather than assuming away.
- The "prototype a payment flow, probably Wanchain first" task in pci-agent#10 is explicitly dropped rather than deferred, so PCI carries no first-hand assessment of that bridge. Accepted: the exclusion in Decision item 5 means the assessment would not change any decision, and the flow it was meant to prove out (business-funded proof generation) is served by designation instead.
- The DUST designation mechanism is documented but PCI has not exercised it end-to-end. If designation turns out to have constraints the docs do not surface (rate limits, registration latency, one-designee-per-holder), pci-zkp#11 will surface them, not this ADR.

### Neutral

- The "which bridge" question is answered as "none yet" rather than resolved on the merits. If a reader wants a ranking for the day it matters: native partner-chain, then a funded ZK-relayer, then LayerZero for reach, then a federated bridge — in that order.
- Forces the distinction between moving *assets* and moving *proofs* to be explicit in PCI's design vocabulary. ADR-005 draws the same line from the other side.

## References

- [ADR-002: Transaction Cost Management](./002-transaction-cost-management.md) — off-chain payment channel economics this decision keeps intact
- [ADR-003: Blockchain and ZKP Stack Selection](./003-blockchain-zkp-stack-selection.md) — Cardano L3 / Midnight L4 split
- [ADR-004: Infrastructure Philosophy](./004-infrastructure-philosophy.md) — the trust-surface-minimisation reasoning this ADR extends to bridges
- [ADR-005: Cardano L1 vs Midnight Sidechain for ZKP](./005-cardano-l1-vs-midnight-sidechain-for-zkp.md) — verifier placement, and the public-input reconstruction pattern the injective-encoding requirement hardens
- [pci-agent#10](https://github.com/peteski22/pci-agent/issues/10) — the decision issue this ADR closes
- [pci-agent#7](https://github.com/peteski22/pci-agent/issues/7) — agent-to-agent autonomous commerce
- [pci-zkp#11](https://github.com/peteski22/pci-zkp/issues/11) — business-pays DUST delegation
- [Midnight DUST architecture](https://docs.midnight.network/concepts/dust-architecture) — `pallet_cnight_observation`, cNIGHT→DUST generation, DUST non-transferability and designation
- [Midnight: sidechains and partner chains](https://docs.midnight.network/concepts/sidechains-partnerchains)
- [Midnight release notes](https://docs.midnight.network/relnotes/overview)
- [Catalyst F13: Decentralised Bridge connecting Cardano and Midnight using novel Zero Knowledge Proof relayer](https://projectcatalyst.io/funds/13/cardano-use-cases-product/decentralised-bridge-connecting-cardano-and-midnight-using-novel-zero-knowledge-proof-relayer) — not approved
- [BlockSec Phalcon root-cause analysis, 21 Jul 2026](https://x.com/Phalcon_xyz/status/2079443108027421183) — primary source: non-injective signed-message encoding in `TreasuryCheck`, verified by decompiling the on-chain Plutus V2 bytecode; recommends `Sha3_256(SerialiseData(...))` over `AppendByteString` concatenation
- [Wanchain Cardano bridge exploit, 21 Jul 2026](https://crypto.news/wanchain-cardano-bridge-exploit-drains-515m-night-worth-9m/) — incident reporting and Midnight Foundation statement
- [Hoskinson on the Wanchain hack (CoinDesk, 22 Jul 2026)](https://www.coindesk.com/business/2026/07/22/midnight-token-rebounds-after-wanchain-bridge-hack-hoskinson-calls-for-industry-overhaul) — third-party bridge architecture as root problem; ZK proofs over operator/multisig trust as the fix
- [Midnight: the Cardano privacy sidechain almost no one is talking about](https://crypto.news/midnight-the-cardano-privacy-sidechain-almost-no-one-is-talking-about/) — Wanchain Cardano↔Midnight bridge announcement
