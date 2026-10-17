# ADR-006: Agent Runtime Targets and the Mobile Story

**Status:** Proposed — amended 2026-10-17 by [ADR-008](008-positioning-nightframes-passport.md)
**Date:** 2026-07-17 (original), 2026-10-17 (amendment)
**Decision:** The Python agent service targets desktop, server and community-node hosts. The mobile story has two tracks that ship in parallel: a thin client that speaks S-PAL to an agent on user-owned hardware, and a native on-device client hosting the model locally. Native on-device is no longer deferred; it is gated on the Bonsai 27B evaluation and the Midnight Mobile SDK.

## Amendment summary (2026-10-17)

| Was | Now | Why |
|---|---|---|
| Native on-device "deferred to Phase 4+" | Active parallel track, Phase 2–3, gated on #6 (Bonsai evaluation) and Midnight Mobile SDK (Q4 2026) | ADR-008: the platform vendor's vision leads with on-device; a deferred promise is a weaker story than a tracked track. The technology case was already made in July. |
| Hybrid split rejected "as the primary shape" | Still not primary; explicitly allowed as an on-device client behaviour once native lands | Unchanged in substance; wording clarified. |
| On-device proof story "lines up with ADR-005" left to a companion ADR | Midnight Mobile SDK (on-phone private transactions, Q4 2026) named as the intended path | New dated input. |
| Companion ADR "when native on-device work starts" | Still required; scoped below as ADR-009 | Unchanged. |
| Default LLM runtime: Ollama | **llama.cpp family (`llama-server`; llamafile on desktop) is the default; Ollama stays a supported option** | Ollama checks ollama.com for updates and bundles cloud features that need `OLLAMA_NO_CLOUD=1` to disable; a sovereignty project's default runtime should make no outbound calls. llama.cpp is already the substrate under both. |
| Rust/Kotlin rewrite "rejected on scope grounds" | **Open option, decided in ADR-009.** A Rust implementation is a live candidate for the native client, and could replace the Python service if it proves out. Not a near-term blocker either way. | The original estimate ("months") was not evidenced; the agent is small and the protocol is in `spec/`. |
| Rejected: cloud-hosted agent as mobile fallback | Unchanged, and extended: a device-grid marketplace is not a fallback either unless a policy's compute-locality condition allows it | ADR-008 §4. |

Everything else in the original text stands. The original is preserved below with the amended passages marked.

## Context

The agent is a Python service (uv-managed, pydantic, pytest, HTTP-first) that hosts the Layer 2 personal-agent responsibilities: intent classification, S-PAL request construction, structured LLM invocation, and coordination with the sovereignty and trust-bridge layers. As of July 2026 it ships a native Ollama backend behind a `LLMBackend` protocol; an OpenAI-compat backend is queued to sit beside it.

Because the founding pitch is data sovereignty — compute the user owns, running against context the user owns — "runs on the user's phone" is a natural line of questioning, and one worth closing explicitly rather than leaving to interpretation.

**What the technology allows in mid-2026:**

- Bonsai 27B (PrismML, 14 Jul 2026, Apache 2.0) makes 27B-class on-device inference technically viable: low-bit builds of Qwen3.6-27B at 3.53 GiB on-disk (Q1_0) and 6.66 GiB (ternary, 1.71 bits/weight), runnable under llama.cpp (CUDA, Metal, CPU) and MLX, with the ternary build reported to retain 94.6% of the FP16 baseline across benchmarks. PrismML positions it as the first 27B-class model to run on a phone (natively on iPhone/iPad via MLX). Phi-4-mini (3.8B, ~2.5 GB Q4) fits smaller envelopes.
- MLC-LLM ships models on iOS (Metal) and Android (OpenCL, on Adreno and Mali GPUs — Vulkan is an MLC desktop backend, not its Android target). llama.cpp has Swift/Kotlin bindings. Native on-device inference is real, not aspirational.
- llamafile v0.10.4 (16 Jul 2026) is a Cosmopolitan libc single-executable that targets desktop OSes (Linux, macOS, Windows, BSD). It **does not run** on iOS or Android — treating it as a "phone story" misstates its runtime target.
- Python on mobile (Kivy, BeeWare, Chaquopy) exists but is fringe; no mainstream mobile LLM runtime speaks it. Shipping the current agent to a phone without a rewrite is not on the table.

**What changed by October 2026 (amendment):**

- Midnight's roadmap dates a **Mobile SDK for Q4 2026**, "capable of creating private transactions entirely on the user's phone". That is the on-phone proof-generation path the original ADR left to a companion decision.
- Midnight's founder now publicly leads with an always-on personal agent on the user's own device ([ADR-008](008-positioning-nightframes-passport.md)). The project's story should not be weaker than the platform's on the one point where the technology case was already made.
- The Bonsai evaluation (#6) has been open since July with no result. It is now the gate for the on-device track, not a nice-to-have.

**The question this ADR closes:** what does "the agent on the user's device" mean in the shipping story, and what does the mobile story look like?

## Decision

The Python agent service targets **desktop, server and community-node** hosts: the user's laptop, home server, self-hosted VM, or a community node under ADR-004 Tier 1–3. Its LLM backends reflect that. (Amended) The default runtime is the llama.cpp family — `llama-server` behind the OpenAI-compat backend, llamafile as the single-file desktop distribution — because neither makes outbound calls. Ollama remains a supported backend but is no longer the default: it checks ollama.com for updates and ships cloud-model and web-search features that have to be switched off (`OLLAMA_NO_CLOUD=1`). Structured output moves to llama.cpp's native JSON-schema grammar so no backend-specific path is needed.

The mobile story is **two parallel tracks** (amended):

| Track | Shape | What it is | Gate |
|---|---|---|---|
| **Thin client** | Phone as UI onto owned compute | Phones speak S-PAL over the network to an agent instance running on hardware the user owns or their community runs (laptop, home box, family Raspberry Pi, community node under ADR-004 Tier 0–3). The phone→agent link inherits the transport floor in [architecture/technical-appendix.md](../architecture/technical-appendix.md) (TLS 1.3 minimum, certificate pinning, rate limiting per DID). | None; this is the Phase 1–3 default and already exists. |
| **Native on-device** (amended: was "Deferred, Phase 4+") | Phone hosts the model | A separate mobile client hosting the model natively via MLC-LLM or llama.cpp iOS/Android bindings, sharing S-PAL schemas, prompts and policies with the Python agent via `spec/`. Not a port of the Python agent — a parallel implementation that speaks the same protocol. Proof generation on-phone via the Midnight Mobile SDK. | #6 (Bonsai 27B evaluation) reaches a decision; Midnight Mobile SDK is public; `spec/` agent API is frozen (#34). Then ADR-009 is written and the work is scheduled. |

Both tracks are governed by the same S-PAL policies, including the compute-locality condition introduced in ADR-008 §4: a rule stating `device_only` is satisfiable only by the native track; a rule allowing `owned_hardware` or `community_node` is satisfiable by either.

Explicitly rejected:

- **Python agent on phones.** Mobile Python runtimes are fringe; no LLM path on them meets the quality bar. Not worth the fight.
- **Hybrid split (small model on device + big model elsewhere) as the primary shape.** Too many moving parts before the primary flow works end-to-end. Permitted as a behaviour of the native client once it exists, subject to the policy's compute-locality condition.
- **Cloud-hosted agent as a default mobile fallback.** Kills the sovereignty pitch; the entire ADR-004 infrastructure philosophy exists to avoid this shape. (Amended) The same applies to a device-grid compute marketplace: it is a backend a policy may *allow*, never a default the agent falls back to.

## Rationale

### Why the thin client stays the default

- **The sovereignty pitch survives.** "The compute is yours" is not "the compute is on your phone." A laptop, home box or community node the user or their community controls is owned compute under ADR-004 Tier 0–3. The phone is a UI onto that compute.
- **The agent already exists in this shape.** Desktop/server-first means iteration continues at current velocity.
- **Model quality is still better on desktop.** Qwen3.6-27B, Phi-4 and the other tier-1 tool-use models run comfortably on modern laptops. On-phone at similar quality (Bonsai) is possible but the user-experience story is unproven, which is what #6 exists to settle.
- **Backend surface stays small and honest.** Two LLM backends (OpenAI-compat on `llama-server` or llamafile as default, Ollama as option) cover essentially every desktop/server runtime worth targeting. Neither pretends to be a mobile runtime, and the default one never talks to a vendor.

### Why native on-device is now a track, not a deferral (amended)

- The technical case was made in July. The only thing "deferred" bought was not having to schedule the work. ADR-008 makes the on-device story strategically load-bearing, so it needs a gate and an owner, not a horizon.
- Midnight's Mobile SDK (Q4 2026) removes the biggest unknown the original ADR named: how the mobile client's proof story lines up with ADR-005.
- A native client that speaks the same S-PAL protocol as the Python agent strengthens the sovereignty story and lets the compute-locality condition's strictest value (`device_only`) be satisfiable at all.
- Running the tracks in parallel still lets `spec/` stabilise first: the gate includes freezing the agent API (#34) before a second implementation opens.

### Why not just make the Python agent portable

- The runtime story (Python service, HTTP-first) and the on-device story (app-embedded LLM, no network) have almost nothing in common architecturally. A single codebase serving both would compromise both.
- (Amended) A Rust rewrite is not ruled out. The agent is small and its contract lives in `spec/`, so a single Rust core (desktop binary plus mobile bindings via UniFFI, llama.cpp or mistral.rs underneath) is a credible shape for the native client and possibly for the whole agent. Whether to build the native client that way, or as Swift/Kotlin on top of MLC-LLM, is ADR-009's first question.

## Alternatives Considered

### Rewrite the agent in a mobile-friendly language now

**Approach:** Port the agent to Rust or Kotlin so a single binary can ship to desktop and phone.

**Pros:** Delivers the "runs on my phone" pitch immediately. Single codebase covers both targets.

**Cons:** Pauses other agent work while it happens. Loses the current Python ecosystem (pydantic, pytest, structured LLM tooling) unless kept as a reference implementation.

**Verdict:** (Amended) Open, not rejected. The original "would take months" estimate was not evidenced; the agent is a few thousand lines with its protocol already in `spec/`. The thin client ships regardless. ADR-009 decides whether the native client is a Rust core with mobile bindings, a Swift/Kotlin client on MLC-LLM, or a Rust rewrite that also replaces the Python service.

### Kivy / BeeWare / Chaquopy Python-on-mobile

**Approach:** Preserve the current codebase and ship the agent to phones via a Python-on-mobile runtime.

**Pros:** No language rewrite. Codebase notionally portable.

**Cons:** No serious mobile LLM inference story runs through these runtimes. Deployment tooling is brittle. Model-hosting path is unresolved.

**Verdict:** Rejected on delivery grounds.

### Cloud-hosted agent

**Approach:** Run agent instances in the cloud so phones can talk to them without needing user-owned hardware.

**Pros:** Phones "just work" — hit a URL.

**Cons:** Contradicts ADR-004 at the foundation. Data sovereignty becomes a veneer on hyperscaler dependency. Metadata leaks.

**Verdict:** Rejected on principle. (Amended) Users without owned hardware are served by community nodes under ADR-004 Tier 1–3, which is the segment gap the original ADR recorded.

### Ship an OpenAI-compat backend and call llamafile the phone story

**Approach:** Add an OpenAI-compat client, host a llamafile, present it as the mobile story.

**Pros:** Small engineering delta. llamafile is a genuinely nice desktop distribution channel.

**Cons:** llamafile does not run on iOS or Android. Presenting it as a phone story misstates its runtime target.

**Verdict:** Rejected on factual grounds. The OpenAI-compat backend is still worth building for its desktop/server value.

### Keep native on-device deferred (amendment-specific)

**Approach:** Leave the July decision as it was and revisit after Phase 3.

**Pros:** No scheduling pressure; `spec/` has longer to settle.

**Cons:** Leaves the project's on-device story weaker than the platform vendor's keynote on the one point where the technology already works. Leaves `device_only` unsatisfiable in S-PAL. Leaves #6 open indefinitely.

**Verdict:** Rejected by ADR-008.

## Consequences

### Positive

- Agent engineering continues on the current trajectory; the native client is additive work with its own gate.
- "Phone that works offline, standalone" becomes a tracked Phase 2–3 deliverable with named gates rather than a Phase 4+ horizon.
- `spec/` is the seam between the two implementations, which pushes more discipline into the protocol layer.
- The LLM-backend surface in the Python agent stays honest.
- The thin-client shape composes with ADR-004 Tier 0–3 without a new tier.

### Negative

- The public pitch still has to be careful until the native client ships: "local AI on your device" is "an app on your phone" only on the native track.
- Users without owned hardware depend on a community node existing near them. Unchanged from July.
- The native client is real engineering (Swift/Kotlin, MLC-LLM or llama.cpp integration, Midnight Mobile SDK, protocol conformance). This ADR schedules the gate, not the work.
- **ADR-009 is required** before native work starts, covering at minimum: language and runtime choice; model tier(s) and the #6 result; how the client obtains policies and identity material from a paired agent or from Passport; and how on-phone proof generation via the Mobile SDK lines up with ADR-005.

### Neutral

- Forces clear thinking about what "user-owned compute" means in messaging: laptops, home boxes and community nodes count; cloud does not; phones count on the native track.
- Ties the on-device story to `spec/` maturity and two external releases (Bonsai evaluation outcome, Midnight Mobile SDK) rather than to the Python agent's shipping cadence.

## References

- [ADR-003: Blockchain and ZKP Stack Selection](003-blockchain-zkp-stack-selection.md)
- [ADR-004: Infrastructure Philosophy](004-infrastructure-philosophy.md)
- [ADR-005: Cardano L1 vs Midnight Sidechain for ZKP](005-cardano-l1-vs-midnight-sidechain-for-zkp.md)
- [ADR-008: Positioning Relative to Midnight Nightframes and Passport](008-positioning-nightframes-passport.md) — the amendment's source
- [Midnight roadmap](https://midnight.network/roadmap) — Mobile SDK, Q4 2026 (read 2026-10-17)
- [Bonsai 27B (PrismML)](https://docs.prismml.com/models/bonsai-27b); [weights on Hugging Face](https://huggingface.co/prism-ml/Ternary-Bonsai-27B-gguf); [announcement](https://prismml.com/news/bonsai-27b)
- [MLC-LLM](https://github.com/mlc-ai/mlc-llm); [Android deploy guide](https://llm.mlc.ai/docs/deploy/android.html)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [llamafile](https://github.com/Mozilla-Ocho/llamafile)
- Issue #6 — Bonsai 27B evaluation (gate for the native track)
- Issue #34 — freeze `agent-api.yaml` as the canonical wire contract (gate for the native track)
- [Ollama backend PR (archived pci-agent#13)](https://github.com/peteski22/pci-agent/pull/13) — anchors the current LLM-backend implementation
