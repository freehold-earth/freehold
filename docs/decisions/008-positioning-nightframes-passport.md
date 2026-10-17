# ADR-008: Positioning Relative to Midnight Nightframes and Passport

**Status:** Proposed
**Date:** 2026-10-17
**Decision:** PCI is repositioned as an independent, open implementation of the sovereign personal agent that Midnight's "Nightframes" vision describes, built on Midnight's identity primitives (Passport, did:midnight) rather than in parallel to them. The project keeps the layers Midnight does not supply: the encrypted local-first context store, S-PAL as the policy gate on what leaves the device, the community-cloud compute model, and local-first inference. Compute-locality becomes an S-PAL condition. The project is renamed Freehold; the rename is recorded here and executed as a separate sweep.

## Context

### What was announced

In October 2026 Charles Hoskinson introduced "Night Frame" at TOKEN2049 (Singapore, 7–8 October), where press coverage on 7 October described it as "a framework that pairs zero-knowledge proofs, multi-party computation and trusted execution on Midnight", shown alongside NightMode and Passport. A follow-up talk in Tokyo widened it into "Nightframes": a private, always-on personal agent that a person fully owns, framed around four words — identity, intention, intelligence, personal. A community retelling on the Learn Midnight newsletter (14 October 2026) describes a Night Frame as a "self-custodied AI agent packaged inside a private, cryptographically secure container", combining "a digital identity (Midnight Passport)", "an AI brain (LAM)" and multi-chain payment capability, working "by intent, not micromanagement", running "on your own devices or trusted hardware", protected by "Trusted Execution Environments and Zero-Knowledge proofs", and able to rent "skills or trading strategies it doesn't know" from other agents.

The Tokyo talk also contains a second thread, roughly 23:26–24:40, that the retelling omits. The pocket device is compared with the computers that flew Apollo; "99.99%" of consumer compute is said to sit idle; and a Nightframe app running while a phone charges overnight is proposed as the on-ramp to "the largest computing grid in human history", with autonomous agents buying, renting and trading that idle capacity in a decentralised marketplace.

Two cautions govern how much weight this ADR puts on the above:

1. **Nightframes is a keynote, not a roadmap item.** The Midnight roadmap (read 17 October 2026) does not mention Nightframes, a personal agent product, or a compute grid. Neither does any post on the Midnight blog through 16 October 2026, including the 16 October post "Building the digital infrastructure of freedom", whose only on-device statement is that the local proof server "generates cryptographic proofs directly on a local device". The roadmap does mention the concrete pieces a Nightframe would be assembled from, with dates (next section).
2. **The two threads have not been verified against a transcript.** The on-device framing comes from a community summary; the grid framing comes from a machine summary of four timestamps. Which one governs where *private data* is processed is unresolved. This ADR is written to be correct under either reading, and the open item is recorded in Consequences.

"Nightframes" is distinct from "NightMode", a dated roadmap item for cross-chain transaction authorisation via offer files. Press coverage conflates them.

### What is actually dated

From the Midnight roadmap, 17 October 2026:

| Item | Quarter | What it is |
|---|---|---|
| Passport SDK v1 | Q4 2026 | Account creation without seed phrases (passkeys); users can "delegate to agents". |
| Mobile SDK | Q4 2026 | "creating private transactions entirely on the user's phone" — on-phone proof generation. |
| AI DevEx for builders | Q4 2026 | AI tooling that understands Compact. |
| NightMode (EVM) | Q4 2026 | Midnight users and contracts authorise transactions EVM chains accept. |
| Passport v2 | Q1 2027 | Decentralised identifiers, verifiable credentials, a trusted-issuer registry, per-app control over which credentials are visible. |
| Midnight MCP server and "Advanced AI expert" | Q1 2027 | A production MCP server for AI tools; agents trained on Midnight. |
| NightMode, more chains | Q1 2027 | Offer files across additional blockchains. |

Status at time of writing: Passport exists as a Stagenet demo (`midnightntwrk/passport-demo`) with no public SDK. `did:midnight` is a usable method, but the hosted preprod and mainnet resolver endpoints returned HTTP 410 on 13 October 2026. Nothing below depends on either being production-ready before the dates above.

### What this means for PCI

PCI's founding pitch, written in December 2025 (first scaffold commits 4 December, repositories made public 27 December), led with the thing Midnight's own founder now leads with: a personal agent that runs on hardware you own, holds your context, acts on your intent and proves things about you without revealing them. The platform vendor has adopted the vision, including the on-device part, and will ship the identity primitives for it on a dated schedule.

Four things in PCI are not covered by anything announced or dated:

1. **An encrypted, local-first context store** (Layer 1). Passport is identity and credentials. Nothing on the roadmap stores, syncs or indexes the personal context an agent reasons over.
2. **S-PAL as a cryptographically enforced policy gate** (Layer 3). The Nightframe story has the agent act on intent; nothing announced constrains *what an agent may disclose, to whom, for how long, and for what onward use*. S-PAL is exactly that language, and ADR-007 has already hardened its commitments.
3. **The community-cloud compute model** (ADR-004). A grid of strangers' phones secured by TEE/MPC is a trustless marketplace. A library, co-op or family box run by a known operator is a social-trust model. They solve the same problem for different people and are complementary; the grid, if it ships, is a Tier 3–4 backend behind the same S-PAL gate.
4. **Local-first inference in the narrow sense**: the model *and* the context stay on devices the user or their community controls by default. The grid thread, if it is the operative one, is the opposite default. PCI's default does not move.

What *is* now redundant is building our own identity anchoring path. The identity docs left `did:prism` as the "implementation-deferred" Cardano-anchored method. Passport v2 delivers DIDs, verifiable credentials and an issuer registry on Midnight, with consumer-grade UX, in Q1 2027. Competing with that would be wasted effort; depending on it is the obvious move.

### The name

"PCI" reads as PCI-DSS to anyone in payments or security, which is precisely the audience a data-sovereignty pitch reaches first. The rename was going to happen regardless of Nightframes; the repositioning is the right moment to do it once. The project name is **Freehold**: the tenure under which you own the property, as opposed to leasehold, where you merely occupy it on someone else's terms. That is the relationship the project wants people to have with their own data. The repository moved to `freehold-earth/freehold` on 17 October 2026. Package names, image names and document headings still say PCI and are changed in a single follow-up sweep, not in this ADR.

## Decision

1. **Position Freehold as "a Nightframe you can run today, on your terms."** The public story leads with the four layers above and names Midnight as the identity, credential and proof substrate. The manifesto, technical manifesto and technical appendix are updated accordingly (edit list in the companion plan). Freehold does not use Midnight vocabulary ("Night", "Frame", "Nightframe") in its own product names.

2. **Identity path: Passport and `did:midnight` first; `did:key` stays the shipping default; `did:prism` becomes an alternative anchor, not the plan.**
   - Root DIDs remain `did:key` held locally until Passport v2 ships DIDs and credentials.
   - Passport SDK v1 (Q4 2026) is the planned primary onboarding path once it is public, replacing the Lace ID onboarding plan. Lace ID / `did:prism` is retained as an alternative for users who already hold one; it is no longer the primary onboarding design.
   - Agent delegation uses Passport's delegation model when the SDK exposes it. The DID-signed request envelope work (ADR-007 hardening) is held until the Passport v1 API is visible, so Freehold does not define a signing envelope that Passport then supersedes.
   - Ephemeral DIDs and the authorisation-record model from the identity privacy model are unchanged.

3. **The agent runs where the user is.** ADR-006 is amended so native on-device is an active parallel track rather than deferred, gated on the Bonsai 27B evaluation and the Midnight Mobile SDK for on-phone proof generation. The Python service remains the desktop, server and community-node agent, with the llama.cpp family (`llama-server`, llamafile) as its default runtime because it makes no outbound calls; Ollama becomes optional. Details in the amended ADR-006.

4. **S-PAL gains a compute-locality condition.** A new `processing` condition on an access rule states where context under that rule may be processed: on the owner's device only, on hardware the owner controls, on a community node, in an attested enclave, or anywhere; and whether hosted third-party models may see it. This is the mechanism that makes a trustless compute grid governable rather than threatening: the grid is just another locality a policy can allow or forbid. Specified as S-PAL 1.1 under the normal improvement process; because it enters the signed preimage, it follows ADR-007's encoding rules.

5. **ADR-004 gains one sentence**: community cloud and a device-grid marketplace are complementary tiers behind the same policy gate, not competing philosophies.

6. **Do not build**: a project-specific DID method, a credential registry, key-custody software, or a compute marketplace. Each is either dated on the Midnight roadmap or outside the project's thesis.

## Rationale

**Why reposition rather than re-architect.** The layered design already separates privacy and verification (Midnight) from storage, policy and compute. Nothing announced changes a layer boundary. The context store, S-PAL, the Aiken validators and the ZKP service are untouched by anything in the roadmap table. What changes is the lead story and the identity dependency.

**Why depend on Passport instead of hedging.** The alternative is maintaining a parallel identity stack against a vendor that controls the chain Freehold proves on. Passport v2's feature list is a superset of what the `did:prism` plan was for. Shipping on `did:key` until then costs nothing: the current interaction pattern never exposes the root DID to a verifier.

**Why keep `did:prism` at all.** It is a W3C-registered method anchored on Cardano, Lace supports it, and Freehold's settlement layer is Cardano. Users who already hold one should be able to use it. "Alternative anchor" is the honest status.

**Why the grid is not a threat.** Three reasons, in decreasing order of confidence. It is not on the roadmap through Q1 2027. Consumer-device compute marketplaces (Golem, Akash, Render) have a decade of precedent in failing to attract general workloads. And even a working grid processes only what a policy lets leave the device, which is the S-PAL question Freehold already answers.

**Why compute-locality belongs in S-PAL.** Retention, derivatives and payment are already conditions on a rule. "Where may this be computed on" is the same kind of statement, policy-bound and verifier-checkable. Putting it in the agent configuration instead would make it a preference, not an enforceable term.

**Why rename now.** Zero users, one repository, one story to tell. Later is strictly more expensive.

## Alternatives Considered

### Treat Nightframes as a competitor and differentiate against it

**Approach:** Keep the current manifesto, add a comparison row, keep `did:prism` as the independent identity path.

**Pros:** No change to plans; independence from a single vendor's identity stack.

**Cons:** Competes on the one layer the vendor will ship first and best. Leaves the manifesto leading with a story the audience will have already heard from Hoskinson. Spends effort on identity anchoring that Passport v2 makes redundant.

**Verdict:** Rejected. Freehold's defensible layers are the ones Midnight is not building.

### Fold Freehold into the Midnight ecosystem as a Passport app

**Approach:** Build Freehold as a reference Nightframe on Passport, adopt Midnight's vocabulary, defer the community cloud and compute-locality work.

**Pros:** Maximum alignment and discoverability inside the ecosystem.

**Cons:** Surrenders the independent positioning and the name. Ties the project to a keynote vision whose grid thread may make hosted compute the default. Drops the two layers (community cloud, S-PAL locality) that are the actual contribution.

**Verdict:** Rejected. Build on Passport, do not become Passport's demo.

### Wait for Passport SDK v1 before deciding anything

**Approach:** Freeze identity and positioning work until Q4 2026.

**Pros:** Decisions made against a real API rather than a roadmap line.

**Cons:** The manifesto is stale now. The `did:prism` issues are misdirecting effort now. The only thing that genuinely needs the API is the envelope-signing design, and that single item is held in this ADR.

**Verdict:** Rejected as a whole; adopted for the one item it fits.

### Rename later, or not at all

**Approach:** Keep "PCI" until the project has traction.

**Pros:** No sweep now.

**Cons:** The PCI-DSS collision is worst with exactly the early audience. Every artefact created from now on would need renaming later.

**Verdict:** Rejected. Rename once, now, in a separate sweep.

## Consequences

### Positive

- The manifesto leads with what Freehold uniquely does and names Midnight as substrate, which is a stronger and more honest pitch than the early-2026 text.
- Identity work shrinks to integration against a vendor SDK plus a thin alternative path, freeing effort for the context store, S-PAL and the agent.
- On-device inference stops being a deferred promise and becomes a tracked parallel implementation.
- S-PAL becomes the only policy language in the ecosystem that can state where computation may happen, which is the lever for governing any future grid.
- One name, chosen before any user has to relearn it.

### Negative

- Freehold's identity roadmap now has an external dependency with vendor-controlled dates. Slippage of Passport v1 or v2 slips the onboarding story.
- Two issues (Passport onboarding; DID anchoring) are blocked on external releases for one to two quarters.
- The compute-locality condition changes the signed preimage. It needs the S-PAL 1.1 encoding, test vectors, validator changes and an agent model change before it is enforceable, not just expressible.

### Neutral

- The on-device-versus-grid ambiguity in the Tokyo talk remains an **open verification item**: watch 07:46–09:30 and 23:26–24:40 and record which framing governs private-data processing. The decision above holds under both; the manifesto wording about Nightframes should quote whichever is accurate.
- Midnight's MCP server (Q1 2027) is a likely integration point for the agent's tool surface and is noted for the agent-to-agent commerce design, not decided here.
- ADR-004's tier table is unchanged; the grid, if it appears, is described as a Tier 3–4 backend.

## References

- [ADR-003: Blockchain and ZKP Stack Selection](003-blockchain-zkp-stack-selection.md)
- [ADR-004: Infrastructure Philosophy](004-infrastructure-philosophy.md) — amended by this ADR with the complementary-grid note
- [ADR-006: Agent Runtime Targets and the Mobile Story](006-agent-runtime-targets-and-mobile-story.md) — amended by this ADR
- [ADR-007: Cardano ↔ Midnight Interop Path](007-cardano-midnight-interop-path.md) — encoding rules the compute-locality condition must follow
- [Identity Privacy Model](../concepts/identity-privacy-model.md) — ephemeral DID and authorisation-record design, unchanged
- [Midnight roadmap](https://midnight.network/roadmap) — read 2026-10-17; source for the dated items table
- [Midnight Passport demo](https://github.com/midnightntwrk/passport-demo) — Stagenet-only at time of writing
- [Learn Midnight: Night Frames](https://learnmidnight.network/p/night-frames) — community retelling, 14 October 2026, not an official Midnight publication
- [Crypto Briefing, 7 October 2026: Hoskinson pitches Night Mode / Night Frame at TOKEN2049](https://cryptobriefing.com/hoskinson-night-frame-midnight-token2049/) — source for the TOKEN2049 framing
- [Midnight blog, 16 October 2026: Building the digital infrastructure of freedom](https://midnight.network/blog/building-the-digital-infrastructure-of-freedom) — latest official post; no agent or grid content
- Hoskinson, Tokyo talk, October 2026 — [YouTube Iyrt2fNAWQ4](https://www.youtube.com/watch?v=Iyrt2fNAWQ4); timestamps 07:46–09:30 and 23:26–24:40 are the passages to verify
- [PRISM DID method](https://github.com/input-output-hk/prism-did-method-spec) — retained as the alternative Cardano-anchored method
