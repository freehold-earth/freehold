# ADR-004: Infrastructure Philosophy

**Status:** Accepted
**Date:** 2026-02-04
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
| **Tier 1: Family/Friends** | Trusted small group | Raspberry Pi at a tech-savvy relative's house | High trust, informal governance |
| **Tier 2: Community** | Local organisation | Library, co-op, community centre | Formal governance, shared costs, local accountability |
| **Tier 3: Federation** | Professional operators under community governance | Regional tech co-op, municipal service | Economies of scale with accountability |
| **Tier 4: Commercial** | Traditional cloud, as last resort | Hyperscaler with strong contractual protections | Convenience vs sovereignty trade-off |

The architecture ensures Tier 0-3 are viable, not just theoretical. Hyperscaler dependency (Tier 4) should be a conscious choice with understood trade-offs, not a default.

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
| Community infrastructure insufficient at launch | High | Medium | Tier 0 (device-only) works without any cloud. Community infra is additive. |
| Quality/reliability concerns deter adoption | Medium | High | Invest in tooling that makes community nodes easy to operate well. |
| Fragmentation across incompatible community providers | Medium | Medium | S-PAL and protocol specs ensure interoperability regardless of operator. |
| Economic sustainability of community nodes | Medium | High | Clear cost models. Federation tier allows professional operation with community governance. |
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
