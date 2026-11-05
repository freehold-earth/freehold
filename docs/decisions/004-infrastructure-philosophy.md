# ADR-004: Infrastructure Philosophy

**Status:** Accepted
**Date:** 2026-02-04
**Amended:** 2026-10-17 ([ADR-008](008-positioning-nightframes-passport.md)); 2026-11-05 (community-node hardware by silicon, chain components under Leios and Midnight mainnet)
**Decision:** Favour distributed community infrastructure over centralised hyperscaler dependency

## Context

PCI needs infrastructure to run: compute for agents, storage for context, networking for sync. The default answer in 2026 is "use a hyperscaler" (AWS, Azure, GCP) or their AI-specific equivalents (OpenAI, Anthropic APIs hosted on hyperscaler infrastructure).

This creates a fundamental tension with PCI's goals. If the infrastructure enabling data sovereignty is itself controlled by the same entities PCI exists to provide alternatives to, the sovereignty is compromised at the foundation.

Beyond philosophical concerns, there are practical risks:

1. **Natural monopoly dynamics** - Once a hyperscaler owns datacentres, power contracts, cooling infrastructure, and talent pipelines in a region, competition becomes difficult. Switching costs grow enormous.

2. **Data extraction** - Infrastructure providers have access to traffic patterns, usage data, and potentially content. Even with encryption, metadata leaks value.

3. **Economic extraction** - Profits flow to shareholders in California, not to communities hosting infrastructure. High-value jobs (ML engineers, architects) remain US-centric in wages and opportunities, even with remote work.

4. **Dependency risk** - Policy changes, price increases, or service discontinuation can happen with little notice. See: Google's graveyard of discontinued services.

5. **Regulatory capture** - Large providers can influence regulations in ways that entrench their position and make alternatives harder.

We've seen these patterns play out with other privatised infrastructure (water, rail, broadband). AI infrastructure has the additional concern that the product being extracted isn't just economic value, but data itself.

## Decision

PCI favours distributed community infrastructure:

| Principle | Implementation |
|-----------|----------------|
| **Local-first** | Data stays on user devices by default. Cloud is opt-in, not required. |
| **Community nodes** | When cloud is needed, prefer community-operated infrastructure to hyperscalers. |
| **Federated** | No single point of control. Multiple independent operators can run compatible infrastructure. |
| **Progressive ownership** | Where private capital is involved, structure for community ownership over time. |
| **Data sovereignty by design** | Infrastructure choices reinforce, not undermine, user control over data. |

### Infrastructure Tiers

PCI supports multiple infrastructure tiers, with preference for local/community options:

| Tier | Description | Example | Trade-offs |
|------|-------------|---------|------------|
| **Tier 0: Device** | User's own hardware | iPhone, laptop, home server | Most sovereign, limited by hardware |
| **Tier 1: Family/Friends** | Trusted small group | A small 32 GB unified-memory desktop at a tech-savvy relative's house | High trust, informal governance |
| **Tier 2: Community** | Local organisation | Library, co-op, community centre | Formal governance, shared costs, local accountability |
| **Tier 3: Federation** | Professional operators under community governance | Regional tech co-op, municipal service | Economies of scale with accountability |
| **Tier 4: Commercial** | Traditional cloud, as last resort | Hyperscaler with strong contractual protections | Convenience vs sovereignty trade-off |

The architecture ensures Tier 0-3 are viable, not just theoretical. Hyperscaler dependency (Tier 4) should be a conscious choice with understood trade-offs, not a default.

> **Amendment 2026-10-17 ([ADR-008](008-positioning-nightframes-passport.md)):** a trustless device-compute marketplace of the kind described in Midnight's "Nightframes" talks, if it ships, is a Tier 3–4 backend: professional or commercial capacity under cryptographic rather than social accountability. It is complementary to community nodes, not a replacement for them, and sits behind the same S-PAL compute-locality condition as every other tier.

### Community Node Hardware

*Amendment 2026-11-05.* Hardware is described by silicon class, meaning the part's memory, its bandwidth and its power envelope, rather than by product, so the tiers stay true as vendors' boxes change. Three facts set the sizes:

1. **The local model tier is 27B-class** ([ADR-006](006-agent-runtime-targets-and-mobile-story.md)): a Q4-class 27B model is about 17 GB before its KV cache, so a box that runs it needs more than 16 GB.
2. **Memory bandwidth, not compute, limits inference on these parts.** Decode speed is roughly memory bandwidth divided by model size in bytes: a 215 GB/s box moving a 17 GB model decodes at about 12 tokens a second, whatever its TFLOPS. The rule places any box not in the table.
3. **Only inference needs the bandwidth-bound box.** The context store, the agent, the proof server and the chain components run on ordinary hardware; a four-core box with 16 GB serves them for a community.

| Node | Silicon class | Serves | Notes |
|------|---------------|--------|-------|
| **Family node** | A 32 GB unified-memory small desktop or laptop: a 100 GB/s-class part such as an Apple M-series or AMD Strix-class APU | A household: one 27B Q4 model with room for its cache | The Tier 0–1 box. Also runs every Freehold service. |
| **Community node** | A 128 GB-plus unified-memory part on a 256-bit LPDDR5X bus, today the AMD Strix Halo class, about 150 W at the wall, roughly $2,500–3,500 in late 2026 and moving with memory prices | A library, co-op or community centre at coordination-tier speed | Users' bandwidth measurements cluster around 215 GB/s against a 256 GB/s spec. By the rule above a 27B Q4 model decodes at about 12 tokens a second (an estimate; nobody has published a measurement for this model) and a 70B Q4 at about 3–5 (measured). The 192 GB part with memory encryption is only worth its price where the governance case needs it, and that feature needs vendor enablement. |
| **Shared node** | Two or three community boxes federated with llama.cpp RPC over WireGuard, under one operator | A community that has outgrown one box | Replicas first; split one model across boxes only within one operator. Never split a model across volunteers or an anonymous marketplace: the activations that cross the split can be inverted back to the prompt, so every machine on the path sees the context. |

The split that matters is services against inference. A community node is an inference box plus whatever runs the services, which can be the same box or a cheap second one; it is not a rack, and it is not a cluster of single-board computers, which cannot hold the model tier at all.

### Chain Components on a Community Node

*Amendment 2026-11-05.* A community node that wants no third party between it and either chain runs three chain components beside the Freehold services: a Cardano relay, a Midnight node with its indexer, and a Midnight proof server. Each of the first two can instead be a hosted API gateway (Blockfrost, Koios, an Ogmios endpoint; Blockfrost for Midnight). **Full node or gateway is a conscious choice the community makes, per chain:** a gateway adds no local disk or memory, but it has its own price (API limits, its availability, and the operator learning which addresses the community watches); a relay costs disk and bandwidth and tells nobody. Tier 1 nodes will mostly use gateways; Tier 2–3 nodes are where relays belong. Tier 0 needs neither, because a device-only Freehold runs without any chain access until a proof is asked for.

**Leios.** Ouroboros Leios ([CIP-0164](https://cips.cardano.org/cip/CIP-0164), status Proposed) raises Cardano's throughput by an order of magnitude or more: the published targets are 10× to 65× current levels through a phased rollout. A public Leios testnet has run since June 2026, IOG's treasury proposal targets a mainnet-ready release candidate by late 2026, and activation goes preview → preprod → mainnet with no mainnet date set. The hardware story is more modest than the throughput story, except for disk. The CIP states that Leios "will not inherently require today's Cardano SPOs or users to provision additional resources, beyond some minor exceptions", that "16 GB of memory will remain sufficient" with the UTxO set kept on disk, and that a relay serving many downstream peers carries more load. The project roadmap's operator target is "6+ cores, 100 Mbps+ bandwidth, SSD storage (modest upgrade)". What grows is the ledger: the CIP's own cost analysis puts it at roughly 400 GB a month (4.7 TB a year) at 150 TxkB/s and over 900 GB a month at 350 TxkB/s. An earlier assumption that a Leios-era full node would need 32 GB or more does not survive those figures; the cost a community relay must plan for is storage that grows by terabytes a year at full throughput, not memory. Leios figures stay forward-looking in this document until it activates; what is firm is that a Leios relay is a Tier 2–3 job and that a Tier 1 node loses nothing by using a gateway.

Two things get stronger, not weaker, under Leios. [ADR-003](003-blockchain-zkp-stack-selection.md)'s deterministic-fee argument: Leios is a consensus-layer change that leaves the ledger's fee rule alone and handles congestion by back-pressure in the mempool rather than by price, so an order of magnitude more volume is more room, not a fee auction. And the manifesto's proof caching and community proof pools move from efficiency measures to capacity planning: proof demand can grow with transaction capacity, anywhere in the published 10× to 65× range, and the proof server is the one component whose load scales with the number of members rather than with the chain.

**Midnight mainnet.** Midnight's mainnet has been live since 17 March 2026, permissionless contract deployment reached it in September 2026, and on 9 October 2026 Midnight shut down its own hosted mainnet indexer and RPC endpoints: anyone who wants chain access now runs a node and indexer or uses a commercial gateway. That is the full-node-or-gateway choice above arriving on the Midnight side, and the milestone the risk table below anticipated. The risk recorded below as "community infrastructure insufficient at launch" is no longer about a launch that may happen; it is the present state, and the mitigation is the same: Tier 0 works without a chain, gateways are the stop-gap, and the compose stack in `infra/` (its `with-nodes` profile) runs the three components a community node needs (node, indexer, proof server) against a local devnet; following mainnet with them is configuration the stack does not yet carry. Block production was federated among named operators at launch, with decentralisation to stake-pool operators scheduled for later in 2026; check Midnight's roadmap before relying on either state.

## Alternatives Considered

### Full Hyperscaler Dependency

**Approach:** Accept that hyperscalers are the most efficient infrastructure providers. Focus PCI's efforts on application-level sovereignty, trusting that encryption protects data even on untrusted infrastructure.

**Pros:**
- Lowest operational complexity
- Best availability and performance
- Established tooling and support
- Fastest path to deployment

**Cons:**
- Metadata exposure even with encryption
- Economic value flows to hyperscalers
- Dependency on entities whose interests may diverge from users
- Undermines the narrative of genuine alternatives

**Verdict:** Contradicts PCI's core thesis. If we accept hyperscaler dependency as inevitable, we're building a better privacy veneer on the existing system, not an alternative to it.

### Pure Self-Hosting Only

**Approach:** Require users to run their own infrastructure. No cloud options at all.

**Pros:**
- Maximum sovereignty
- No third-party trust required
- Clear, simple principle

**Cons:**
- Excludes most potential users
- Requires technical expertise
- Hardware costs and maintenance burden
- Availability limited by home internet/power

**Verdict:** Too exclusionary. A system only technical experts can use doesn't change the broader landscape.

### Hybrid with Hyperscaler Default

**Approach:** Support community infrastructure but default to hyperscalers for ease of onboarding.

**Pros:**
- Easier adoption
- Community options available for those who want them
- Pragmatic compromise

**Cons:**
- Defaults matter enormously. Most users won't change them.
- Creates two-tier system where sovereignty is only for the motivated
- Hyperscaler dependency becomes the norm, community infrastructure an afterthought

**Verdict:** Defaults shape outcomes. If hyperscaler is the default, that's what PCI becomes.

## Counter-Arguments Addressed

Critics of distributed/community infrastructure raise legitimate concerns. Our responses:

| Concern | Claim | Response |
|---------|-------|----------|
| **Economies of scale** | "Hyperscalers are 10x more efficient per compute unit" | True for raw compute, but irrelevant when the product is sovereignty. Also: who captures that efficiency? Not the user. |
| **Security** | "Hyperscalers have world-class security teams" | Security from whom? They secure your data from everyone except themselves. Distributed infrastructure eliminates single honeypots. |
| **Reliability** | "99.999% uptime SLAs" | Local-first means offline-capable. You're not dependent on their uptime for basic functionality. |
| **Expertise** | "Communities can't run infrastructure" | Guifi.net: tens of thousands of nodes. Libraries already provide internet access. The expertise exists; it needs support, not dismissal. |
| **Cost** | "Community infrastructure is more expensive" | Per-unit perhaps, but community models don't extract profit margins. And the "cost" of hyperscaler dependency includes surrendered autonomy. |
| **Convenience** | "Users want things to just work" | Agreed. That's why PCI must make community options as easy as hyperscaler options, not lecture users about why inconvenience is good for them. |

## Real-World Examples

Distributed community infrastructure isn't theoretical:

| Project | Location | Scale | What It Proves |
|---------|----------|-------|----------------|
| [Guifi.net](https://guifi.net/) | Catalonia | 37,000+ nodes (2021) | Community networks can reach significant scale |
| [El Servidor del Barri](https://barri.elmercatcultural.cat/) | Barcelona | Neighbourhood | Community cloud services (storage, passwords, local AI) are viable |
| [Stockholm Data Parks](https://stockholmdataparks.com/) | Stockholm | Citywide | Datacentre waste heat warms 31,000+ flats via district heating |
| [Community Box](https://www.bbc.co.uk/news/articles/c0rpy7envr5o) | UK Rural | Multiple deployments | BBC-funded rural cloud infrastructure demonstrates UK appetite |
| [NYC Mesh](https://www.nycmesh.net/) | New York | Citywide | Community networking in dense urban environments |
| [World Mobile](https://worldmobile.io/) | Global | 100,000+ nodes | Token-incentivised community telecoms infrastructure can scale globally |

These exist today. PCI's job is to make them viable infrastructure for data sovereignty applications, not to pretend they don't exist while defaulting to AWS.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Community infrastructure insufficient at launch | High | Medium | Tier 0 (device-only) works without any cloud. Community infra is additive. Midnight mainnet is live and its hosted RPC is gone (2026), so this is the present state rather than a forecast: hosted gateways bridge the gap while community nodes come up. |
| Quality/reliability concerns deter adoption | Medium | High | Invest in tooling that makes community nodes easy to operate well. |
| Fragmentation across incompatible community providers | Medium | Medium | S-PAL and protocol specs ensure interoperability regardless of operator. |
| Economic sustainability of community nodes | Medium | High | Clear cost models. Federation tier allows professional operation with community governance. The manifesto's $5–20 per member per month assumes communities run stake pools as well as compute nodes; Leios's published figures add disk and bandwidth to that pool, not a new class of hardware. Revisit when Leios reaches mainnet. |
| Hostile regulatory environment for decentralised infrastructure | Low | High | Geographic distribution. Legal structures vary by jurisdiction. |
| Hyperscalers offer "community-washed" alternatives | Medium | Medium | Certification/trust registry distinguishes genuine community infrastructure. |

## Consequences

### Positive

- Infrastructure choices align with sovereignty goals
- Economic value can stay in communities
- No single point of failure or control
- Regulatory diversity (different jurisdictions, different operators)
- Genuine alternative to hyperscaler dependency, not just a privacy layer on top

### Negative

- Higher operational complexity than "just use AWS"
- Slower initial deployment while community infrastructure develops
- Need to invest in tooling for community operators
- Some users will choose hyperscaler convenience anyway
- Risk of being dismissed as impractical idealism

### Neutral

- Forces clear thinking about trust assumptions
- Requires ongoing community building, not just code
- Success depends on factors beyond PCI's direct control

## References

- [PCI Manifesto - Community Cloud](../concepts/manifesto.md)
- [Guifi.net](https://guifi.net/)
- [El Servidor del Barri](https://barri.elmercatcultural.cat/)
- [Stockholm Exergi - Heat Recovery](https://www.stockholmexergi.se/en/heat-recovery/)
- [Blog: AI Growth Zones - Gift Horse or Trojan Horse?](https://peteski22.github.io/blog/2026/02/04/ai-growth-zones-gift-horse-or-trojan-horse/)
- [CIP-0164: Ouroboros Leios](https://cips.cardano.org/cip/CIP-0164) and the [Leios roadmap](https://leios.cardano-scaling.org/docs/roadmap/)
- [Cardano is ready to grow. Leios is how it gets there](https://cardano.org/news/2026-05-14-cardano-is-ready-to-grow/) (14 May 2026)
- [Midnight: State of the Network, October 2026](https://midnight.network/blog/state-of-the-network-october-2026) and [September 2026](https://midnight.network/blog/state-of-the-network-september-2026)
- [ADR-006: Agent Runtime Targets](006-agent-runtime-targets-and-mobile-story.md) (the 27B-class local model tier)
