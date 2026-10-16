# ADR-006: pci-agent Runtime Targets and the Mobile Story

**Status:** Proposed
**Date:** 2026-07-17
**Decision:** pci-agent-the-Python-service targets desktop and server. The near-term mobile story is thin-client (phone talks S-PAL to a pci-agent on user-owned hardware); native on-device is deferred to a separate implementation.

## Context

pci-agent is a Python service (uv-managed, pydantic, pytest, HTTP-first) that hosts the Layer 2 personal-agent responsibilities: intent classification, S-PAL request construction, structured LLM invocation, and coordination with the sovereignty and trust-bridge layers. As of July 2026 it ships a native Ollama backend behind a `LLMBackend` protocol; an OpenAI-compat backend is queued to sit beside it.

Because PCI's founding pitch is data sovereignty — compute the user owns, running against context the user owns — "runs on the user's phone" is a natural line of questioning, and one worth closing explicitly rather than leaving to interpretation.

**What the technology allows in mid-2026:**

- Bonsai 27B (PrismML, 14 Jul 2026, Apache 2.0) makes 27B-class on-device inference technically viable: low-bit builds of Qwen3.6-27B at 3.53 GiB on-disk (Q1_0) and 6.66 GiB (ternary, 1.71 bits/weight), runnable under llama.cpp (CUDA, Metal, CPU) and MLX, with the ternary build reported to retain 94.6% of the FP16 baseline across benchmarks. PrismML positions it as the first 27B-class model to run on a phone (natively on iPhone/iPad via MLX). Phi-4-mini (3.8B, ~2.5 GB Q4) fits smaller envelopes.
- MLC-LLM ships models on iOS (Metal) and Android (OpenCL, on Adreno and Mali GPUs — Vulkan is an MLC desktop backend, not its Android target). llama.cpp has Swift/Kotlin bindings. Native on-device inference is real, not aspirational.
- llamafile v0.10.4 (16 Jul 2026) is a Cosmopolitan libc single-executable that targets desktop OSes (Linux, macOS, Windows, BSD). It **does not run** on iOS or Android — treating it as a "phone story" misstates its runtime target.
- Python on mobile (Kivy, BeeWare, Chaquopy) exists but is fringe; no mainstream mobile LLM runtime speaks it. Shipping the current pci-agent to a phone without a rewrite is not on the table.

**The question this ADR closes:** what does "pci-agent on the user's device" mean in PCI's near-term shipping story, and what does the mobile story look like?

## Decision

pci-agent-the-Python-service targets **desktop and server** hosts: the user's laptop, home server, or self-hosted VM. Its LLM backends (Ollama today, OpenAI-compat next) reflect that — both are desktop/server LLM runtimes.

The mobile story is **thin-client-primary, native-on-device-deferred**:

| Horizon | Shape | What it is |
|---------|-------|------------|
| Near-term (Phase 1–3) | **Thin-client** | Phones speak S-PAL over the network to a pci-agent instance running on hardware the user owns (laptop, home box, family Raspberry Pi under ADR-004's Tier 0–1). The phone→agent link is not an arbitrary deployment choice — it inherits the transport floor in [architecture/technical-appendix.md](../architecture/technical-appendix.md) (TLS 1.3 minimum, certificate pinning, rate limiting per DID). |
| Deferred (Phase 4+) | **Native on-device** | A separate mobile client hosting the model natively via MLC-LLM or llama.cpp iOS/Android bindings, sharing S-PAL schemas, prompts, and policies with pci-agent via `pci-spec`. Not a port of pci-agent — a parallel implementation that speaks the same protocol. |

Explicitly rejected:

- **Python pci-agent on phones.** Mobile Python runtimes are fringe; no LLM path on them meets the quality bar. Not worth the fight.
- **Hybrid split (small model on device + big model elsewhere) as the primary shape.** Too many moving parts before the primary flow works end-to-end. Revisit once native on-device lands.
- **Cloud-hosted pci-agent as a default mobile fallback.** Kills the sovereignty pitch outright; the entire ADR-004 infrastructure philosophy exists to avoid this shape.

## Rationale

### Why thin-client wins near-term

- **The sovereignty pitch survives.** "The compute is yours" is not "the compute is on your phone." A laptop or home box the user owns is user-owned compute — it lands in ADR-004's Tier 0. The phone is a UI onto that compute.
- **pci-agent already exists in this shape.** Ship desktop/server-first means iteration continues at current velocity. A native mobile rewrite would fork engineering budget and slow every other layer.
- **Model quality is currently better on desktop.** Qwen3.6-27B, Phi-4, and the other tier-1 tool-use models run comfortably on modern laptops. On-phone at similar quality (Bonsai) is possible but freshly-mainlined; the user experience story is unproven.
- **Backend surface stays small and honest.** Two LLM backends (Ollama + OpenAI-compat) cover essentially every desktop/server runtime worth targeting. Neither pretends to be a mobile runtime.

### Why native on-device is deferred, not rejected

- Bonsai and its successors will make on-device viable for real workloads within the next few Phases.
- A native mobile client that speaks the same S-PAL protocol as pci-agent is a strengthening of the sovereignty story, not a replacement of the thin-client story — both can coexist.
- Deferring lets pci-spec stabilise first. A protocol split between "pci-agent's S-PAL" and "mobile-client's S-PAL" would be painful; better to freeze pci-spec before opening a second implementation.

### Why not just make pci-agent portable

- The runtime story (Python service, HTTP-first) and the on-device story (app-embedded LLM, no network) have almost nothing in common architecturally. A single codebase serving both would compromise both.
- Rewriting pci-agent in Rust or Kotlin to make it phone-shippable is Phase 4+ scope, not a near-term hedge.

## Alternatives Considered

### Rewrite pci-agent in a mobile-friendly language now

**Approach:** Port pci-agent to Rust or Kotlin so a single binary can ship to desktop and phone.

**Pros:** Delivers the "runs on my phone" pitch immediately. Single codebase covers both targets.

**Cons:** Fork every other roadmap item to fund the rewrite. Loses the current Python ecosystem (pydantic, pytest, structured LLM tooling). Ties near-term shipping to a rewrite that would take months.

**Verdict:** Rejected on scope grounds. The near-term thin-client shape delivers the same sovereignty properties without the rewrite.

### Kivy / BeeWare / Chaquopy Python-on-mobile

**Approach:** Preserve the current codebase and ship pci-agent to phones via a Python-on-mobile runtime.

**Pros:** No language rewrite. Codebase notionally portable.

**Cons:** No serious mobile LLM inference story runs through these runtimes. Deployment tooling is brittle. Model-hosting path is unresolved. Whatever LLM backend we shipped would be a compromise.

**Verdict:** Rejected on delivery grounds. Fringe deployment target with unresolved LLM story.

### Cloud-hosted pci-agent

**Approach:** Run pci-agent instances in the cloud so phones can talk to them without needing user-owned hardware.

**Pros:** Phones "just work" — hit a URL.

**Cons:** Contradicts ADR-004's infrastructure philosophy at the foundation. Data sovereignty is a veneer on hyperscaler dependency. Metadata leaks. Non-starter.

**Verdict:** Rejected on principle. The entire architecture exists to avoid this shape.

### Ship an OpenAI-compat backend and call llamafile the phone story

**Approach:** Add an OpenAI-compat client to pci-agent, host a llamafile, present it as the mobile story.

**Pros:** Small engineering delta from the current Ollama-only shape. llamafile is a genuinely nice desktop distribution channel.

**Cons:** llamafile does not run on iOS or Android. Presenting it as a phone story misstates its runtime target and would create a credibility gap the first time a user tried it on their device.

**Verdict:** Rejected on factual grounds. The OpenAI-compat backend is still worth building for its desktop/server value, but this ADR does not adopt it as a mobile answer.

## Consequences

### Positive

- pci-agent engineering continues on the current trajectory without a mobile-rewrite branch.
- The "phone that just works, offline, standalone" story becomes an explicit Phase 4+ deliverable rather than an implicit Phase 1 promise the code cannot keep.
- pci-spec becomes the seam between the desktop/server agent and any future on-device implementation — pushing more discipline into the protocol layer, which pays off elsewhere.
- The LLM-backend surface in pci-agent stays honest: Ollama + OpenAI-compat cover the desktop/server world; nothing pretends to be a mobile runtime.
- The thin-client shape composes naturally with ADR-004's Tier 0–1 (device / family-and-friends) infrastructure story — no new tier is required.

### Negative

- The public pitch has to be careful. "Local AI on your device" is not "an app on your phone" in Phase 1–3; that gap needs to be communicated without souring the sovereignty story.
- Users without a laptop or home box have no PCI story in Phase 1–3 beyond "borrow one." This is a real segment gap.
- A future native-on-device client is real engineering (Swift/Kotlin plus MLC-LLM/llama.cpp integration plus protocol conformance) — deferred, not zero-cost. Somebody will build it eventually; this ADR does not assign that work.
- Requires an eventual companion ADR when native on-device work starts, covering at minimum: language and runtime choice, model tier(s), how the mobile client obtains policies and identity material from a paired pci-agent (if pairing is the shape), and how the mobile client's local proof/verification story lines up with ADR-005.

### Neutral

- Forces clear thinking about what "user-owned compute" means in PCI's messaging — laptops and home boxes count, cloud does not, phones are a special case.
- Ties the mobile-first story to pci-spec maturity rather than to pci-agent's shipping cadence.

## References

- [ADR-003: Blockchain and ZKP Stack Selection](003-blockchain-zkp-stack-selection.md)
- [ADR-004: Infrastructure Philosophy](004-infrastructure-philosophy.md) — the sovereignty and self-hosting rationale this ADR builds on
- [ADR-005: Cardano L1 vs Midnight Sidechain for ZKP](005-cardano-l1-vs-midnight-sidechain-for-zkp.md) — shapes what an on-device client would need to compute locally when native on-device lands
- [Bonsai 27B (PrismML)](https://docs.prismml.com/models/bonsai-27b) — low-bit (Q1_0 / ternary) builds of Qwen3.6-27B; [weights on Hugging Face](https://huggingface.co/prism-ml/Ternary-Bonsai-27B-gguf) (Apache 2.0), [announcement](https://prismml.com/news/bonsai-27b)
- [MLC-LLM](https://github.com/mlc-ai/mlc-llm) — mobile LLM runtime for iOS (Metal) and Android (OpenCL); see the [Android deploy guide](https://llm.mlc.ai/docs/deploy/android.html)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — reference LLM runtime with iOS and Android bindings
- [llamafile](https://github.com/Mozilla-Ocho/llamafile) — desktop-only single-executable distribution (mozilla-ai/llamafile)
- [pci-agent#13](https://github.com/peteski22/pci-agent/pull/13) — Ollama backend PR that anchors the current LLM-backend implementation
