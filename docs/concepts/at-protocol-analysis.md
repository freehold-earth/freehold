# AT Protocol Analysis for PCI

**Status:** Complete
**Date:** 2025-12-21

## TL;DR for Reply

> "AT Protocol and PCI solve different but complementary problems. AT Protocol is about **data portability** - taking your social graph when you leave a platform. PCI is about **data sovereignty** - cryptographically controlling who can access your data and what they can do with it, with on-chain enforcement.
>
> AT Protocol currently only supports public content - no encryption, no private data (that's planned for 'phase 2' of their protocol). PCI is built around encryption-first, ZK proofs for selective disclosure, and smart contract policy enforcement.
>
> They could potentially complement each other - AT Protocol for federated distribution, PCI for the cryptographic access control layer that AT Protocol lacks. But AT Protocol doesn't replace what PCI does."

---

## What is AT Protocol?

The **Authenticated Transfer Protocol** (atproto) is the protocol behind Bluesky. It's designed for decentralized social networking with portable user accounts.

### Core Components

| Component | Purpose |
|-----------|---------|
| **PDS** (Personal Data Server) | Hosts your data, can self-host or use provider |
| **DIDs** | Decentralized identifiers (similar to our approach) |
| **Data Repos** | Merkle tree of signed records (posts, likes, follows) |
| **Lexicon** | Schema system for interoperability |
| **Relays** | Aggregate data from many PDSes |
| **App Views** | Provide feeds, search, aggregation |

### What It Solves

- **Account portability** - Move your account between servers
- **Algorithmic choice** - Choose your own feed algorithms
- **Interoperability** - Different apps can share the same social graph
- **No platform lock-in** - Data lives in your PDS, not the app

## Critical Limitation: PUBLIC ONLY

**AT Protocol currently only supports public content.**

From Bluesky team:
> "Non-public content mechanisms for private group and one-to-one communication will be an entire second phase of protocol development."

### No Encryption Today

- No encryption at rest
- No E2EE for DMs (coming later)
- No private accounts
- Data repos are public, signed, but readable by anyone
- Team explicitly discourages storing encrypted content in repos

### Future Plans (2025+)

- E2EE DMs (possibly using MLS/Signal protocol)
- Group-private data
- Private accounts
- But this is "major additional component" not a bolt-on

## PCI vs AT Protocol Comparison

| Aspect | AT Protocol | PCI |
|--------|-------------|-----|
| **Primary goal** | Data portability | Data sovereignty |
| **Data location** | PDS (federated cloud) | Local device |
| **Encryption** | None (public only) | AES-256-GCM always |
| **Access control** | Server-enforced | Contract-enforced |
| **Privacy model** | Pseudonymous DIDs | ZK proofs, ephemeral DIDs |
| **Verification** | None | Zero-knowledge proofs |
| **Policy enforcement** | Social/terms | Cryptographic/on-chain |
| **Selective disclosure** | Not possible | Core feature |
| **Scope** | Social networking | All personal data |

## What AT Protocol Does Well

1. **Portable social identity** - DID-based, can migrate
2. **Federated hosting** - Self-host or use providers
3. **Open ecosystem** - Multiple apps on same protocol
4. **Algorithmic transparency** - See how feeds work

## What AT Protocol Lacks (That PCI Has)

1. **Encryption** - Data is public
2. **Selective disclosure** - Can't share age without birthdate
3. **Policy enforcement** - No way to enforce data usage rules
4. **Audit trails** - No on-chain record of who accessed what
5. **Cryptographic guarantees** - Trust is social, not mathematical
6. **Private data** - Everything is public by design (for now)

## Could They Work Together?

**Potentially yes**, in different layers:

```
┌─────────────────────────────────────────┐
│         Application Layer               │
│  (Bluesky, other AT Protocol apps)      │
├─────────────────────────────────────────┤
│         AT Protocol Layer               │
│  (Data portability, federation)         │
├─────────────────────────────────────────┤
│           PCI Layer                     │
│  (Encrypted storage, ZK proofs,         │
│   policy enforcement, selective         │
│   disclosure)                           │
├─────────────────────────────────────────┤
│         Cardano/Midnight                │
│  (On-chain enforcement, ZK circuits)    │
└─────────────────────────────────────────┘
```

Example integration:
- Store PCI-encrypted data in AT Protocol repo
- PCI policies control who can decrypt
- AT Protocol handles distribution/federation
- Cardano enforces access policies

**But:** Bluesky team discourages encrypted content in repos, so this would go against their design.

## Recommendation

**No action needed for now.**

AT Protocol and PCI are complementary, not competing. AT Protocol is focused on public social networking with portability. PCI is focused on private data with cryptographic sovereignty.

### If Asked About Integration

1. Monitor AT Protocol's "phase 2" private data work
2. Their E2EE approach might inform our design
3. DID compatibility is already there (we use did:key, they use did:plc)
4. Could potentially build PCI-aware AT Protocol apps in future

### Key Differentiator

> AT Protocol: "I can take my data when I leave"
> PCI: "I control who sees my data and what they can do with it"

## References

- [AT Protocol Overview](https://atproto.com/guides/overview)
- [AT Protocol Data Repos](https://atproto.com/guides/data-repos)
- [Private Data Discussion](https://github.com/bluesky-social/atproto/discussions/121)
- [2025 Protocol Roadmap](https://docs.bsky.app/blog/2025-protocol-roadmap-spring)
- [Private Data Working Group](https://atproto.wiki/en/working-groups/private-data)
- [TechCrunch on ATProto Future](https://techcrunch.com/2025/03/26/whats-next-for-atproto-the-protocol-powering-bluesky-and-other-apps/)
