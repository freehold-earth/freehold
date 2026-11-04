# AT Protocol Analysis for Freehold

**Status:** Complete
**Date:** 2025-12-21
**Updated:** 2026-11-04 (recommendation actioned for identity, #92)

## TL;DR for Reply

> "AT Protocol and Freehold solve different but complementary problems. AT Protocol is about **data portability** - taking your social graph when you leave a platform. Freehold is about **data sovereignty** - cryptographically controlling who can access your data and what they can do with it, with on-chain enforcement.
>
> AT Protocol currently only supports public content - no encryption, no private data (that's planned for 'phase 2' of their protocol). Freehold is built around encryption-first, ZK proofs for selective disclosure, and smart contract policy enforcement.
>
> They could potentially complement each other - AT Protocol for federated distribution, Freehold for the cryptographic access control layer that AT Protocol lacks. But AT Protocol doesn't replace what Freehold does."

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

## Freehold vs AT Protocol Comparison

| Aspect | AT Protocol | Freehold |
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

## What AT Protocol Lacks (That Freehold Has)

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
│           Freehold Layer                     │
│  (Encrypted storage, ZK proofs,         │
│   policy enforcement, selective         │
│   disclosure)                           │
├─────────────────────────────────────────┤
│         Cardano/Midnight                │
│  (On-chain enforcement, ZK circuits)    │
└─────────────────────────────────────────┘
```

Example integration:
- Store Freehold-encrypted data in AT Protocol repo
- Freehold policies control who can decrypt
- AT Protocol handles distribution/federation
- Cardano enforces access policies

**But:** Bluesky team discourages encrypted content in repos, so this would go against their design.

## Recommendation

**Identity: done. Data: no action.**

AT Protocol and Freehold are complementary, not competing. AT Protocol is focused on public social networking with portability. Freehold is focused on private data with cryptographic sovereignty.

The one integration point worth taking was identity, and it is taken (#92, [ADR-009](../decisions/009-atproto-root-identity.md)): an atproto account (`did:plc` or `did:web`) can be a Freehold root identity. The account publishes a Freehold-held Ed25519 key as an `earth.freehold.rootKey` record in its own repository, and verifiers of authorization records resolve that binding. The ephemeral-DID layer is unchanged, and nothing private is written to the repository: the record is one public key. A node that signs its members in with atproto can hand them Freehold identities without a second login.

### Still Not Pursued

1. Storing Freehold data, encrypted or not, in atproto repositories. The Bluesky team discourages it and the repositories are public by design.
2. Monitor AT Protocol's "phase 2" private data work; their E2EE approach might inform our design.
3. Freehold-aware AT Protocol apps remain possible in future.

### Key Differentiator

> AT Protocol: "I can take my data when I leave"
> Freehold: "I control who sees my data and what they can do with it"

## References

- [AT Protocol Overview](https://atproto.com/guides/overview)
- [AT Protocol DIDs](https://atproto.com/specs/did), [Lexicon](https://atproto.com/specs/lexicon) and [permissions](https://atproto.com/specs/permission) — what the root key binding relies on
- [AT Protocol Data Repos](https://atproto.com/guides/data-repos)
- [Private Data Discussion](https://github.com/bluesky-social/atproto/discussions/121)
- [2025 Protocol Roadmap](https://docs.bsky.app/blog/2025-protocol-roadmap-spring)
- [Private Data Working Group](https://atproto.wiki/en/working-groups/private-data)
- [TechCrunch on ATProto Future](https://techcrunch.com/2025/03/26/whats-next-for-atproto-the-protocol-powering-bluesky-and-other-apps/)
