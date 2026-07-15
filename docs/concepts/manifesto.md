# Reclaiming the Ghost in the Machine

**A Blueprint for Personal Context Infrastructure**

> "Words are good for the soul, tokens are good for the context."

## Executive Summary

**The Problem:** Big Tech has built a $2 trillion context economy that harvests our digital lives to create shadow profiles and AI models trained on our humanity. We've become unpaid data laborers in our own digital existence.

**The Solution:** Personal Context Infrastructure (PCI)—a term coined by Jad Esber and Apurva Chitnis of koodos—implemented as a four-layer sovereign stack that keeps your data local, proves facts without revealing details, and enforces your privacy rules through cryptographic law, not corporate policy.

**The Path:** Using existing technologies (local AI, zero-knowledge proofs, smart contracts, and micropayments), we can build this TODAY. This isn't theoretical—iPhone 15s can run local models, WebAssembly enables browser-based agents, and the cryptographic tools already exist.

**The Ask:** Join us in building the S-PAL standard—the **Sovereign Privacy & Access Language**—a machine-readable Bill of Rights that makes your privacy mathematically enforceable. We need developers, early adopters, and services willing to respect user sovereignty.

---

## The Digital Soul vs. The Context Economy

We are currently training our replacements. It is not just our history or our preferences that are being mined; it is the infinite digital reflection of our humanity—our **Digital Soul**.

Big Tech has built a $2 trillion **context economy**—a machine that ingests our memories, struggles, and secrets to build a revenue stream that mimics us. They call it "improving the user experience." We should call it what it is: **selling our own humanity back to us as a service.**

As articulated at MozFest 2025, context goes beyond raw data—it's dynamic, situational, and relational. Your context in a work Slack differs entirely from your context in a family WhatsApp. Identity isn't fixed; it's performed differently across platforms and relationships. Yet the context economy flattens this multiplicity into a single exploitable profile.

Think of credit scores—a primitive form of context aggregation that already determines access to housing, employment, and financial services. Now imagine that gatekeeping power expanded to every digital interaction. Those without established digital histories face exclusion from the digital economy entirely. This is the future the context economy is building.

The industry offers us "privacy policies" that no one reads. This is a lie. We do not need better policies; we need better **physics**. We need a system where the rules of engagement are not legal suggestions, but cryptographic laws.

This is a proposal for **Personal Context Infrastructure (PCI)**. It creates a world where we stop sending our souls to the machine, and instead force the machine to come to our data, on our terms, protected by our non-negotiables. A world where you can participate in the digital economy without first being surveilled into it.

---

## The Adoption Path: From Zero to Sovereignty

Building PCI doesn't require everyone to change everything at once. We can create a **vertical slice** of the full experience - even if some parts are initially simplified - to prove the model works.

### Phase 1: "The Proof of Life"
**What:** A browser extension + simple GUI that demonstrates the core PCI experience
- Local agent manages multiple ephemeral identities
- Basic S-PAL policy templates (one-click privacy for common sites)
- Visual policy builder for non-technical users
- No blockchain required initially - just local encryption

**Why Start Here:** Immediate value, zero friction installation, proves the UX can be intuitive

### Phase 2: "The Local Fortress"
**What:** Add the personal data vault and basic AI capabilities
- Cross-device sync via Yjs
- Local SLM integration (or WASM-based remote agent for lighter devices)
- Natural language → S-PAL policy conversion
- Policy testing sandbox ("See what this policy allows/blocks")

**Why This Matters:** Users see their data staying local while functionality increases

### Phase 3: "The Trust Network"
**What:** Enable cryptographic proofs and smart contract enforcement
- Midnight integration for ZKP generation
- Cardano smart contracts for S-PAL enforcement
- First "PCI-native" service partnerships
- Proof caching and proof markets for efficiency

**Why This Completes It:** Full sovereignty with mathematical guarantees

### Phase 4: "The Tipping Point"
**What:** Network effects make PCI expected, not exceptional
- S-PAL becomes a standard like robots.txt
- Services compete on how well they respect user sovereignty
- Template marketplace for specialized policies
- Governance structure fully operational

**Bootstrap Strategy:** We don't need everyone immediately. We need:
- 100 community nodes (libraries, co-ops, privacy groups) providing compute
- 1,000 privacy-conscious early adopters to prove it works
- 10 services willing to accept S-PAL policies
- 1 killer app that shows why this matters

---

## Addressing the Hard Problems

### The Key Management Reality

**The Challenge:** Losing cryptographic keys means losing your digital identity. The "$5 wrench attack" problem - coercion defeats any biometric-only system.

**Our Approach:**

**Progressive Security Levels:**
1. **Starter Mode:** Username/password with encrypted local storage (like current password managers)
2. **Standard Mode:** Biometrics for convenience + passphrase for true security
3. **Sovereign Mode:** Full cryptographic keys with social recovery

**Social Recovery via Secret Sharing:**
- Your key splits into 5 pieces (Shamir's Secret Sharing)
- Need any 3 pieces to recover
- Distribute to: trusted contact, hardware key, cloud backup (encrypted), bank safety deposit, lawyer
- No single point of failure, no single point of coercion

**Critical Design Choice:** We prioritize "easy enough that grandma uses it" over "perfect security nobody adopts." Face ID is convenient but vulnerable to state coercion - we use it for daily convenience but require additional factors for sovereignty-critical operations.

### The Computation Reality Check

**Current State (2024/2025):**
- iPhone 15 Pro can run 3B parameter models locally
- M-series Macs handle 7-8B parameter models easily  
- WebAssembly enables browser-based agents today
- Dedicated AI chips becoming standard (NPUs in most new laptops)

**Our Solutions:**

**Tiered Processing:**
1. **Device-Native:** Phone/laptop for basic operations
2. **Community Cloud:** Shared infrastructure with your trusted groups (NEW - see below)
3. **Local Network:** Home server for power users who want full control
4. **Trusted Compute:** Your own VM as last resort (even on big tech cloud, still YOUR encryption)

**The Community Cloud Innovation:**

This is where PCI gets interesting - and sustainable. Instead of everyone becoming a sysadmin or crawling back to Big Tech, we enable **Community Compute Cooperatives**:

**Geographic Communities:**
- Neighborhood data co-ops (like "El Servidor del Barri" in Barcelona - already running!)
- City-level sovereignty infrastructure (Munich has Linux, next step: PCI nodes)
- Local libraries or community centers hosting nodes
- Community Box initiatives (deployed in UK rural areas for local cloud)
- Guifi.net style networks (Catalonia's community wireless expanding to data)

**Tech Community Partnerships:**
- Local tech businesses with existing colocated infrastructure
- Small ISPs offering community rates for rack space
- Tech co-ops sharing bandwidth and hardware
- Transparent pricing: all costs (rent, power, hardware) visible
- Profits reinvested, not extracted to shareholders

**Affinity Communities:**
- Professional associations (lawyers, doctors, artists sharing infrastructure)
- Privacy advocacy groups running nodes for members
- Universities providing compute for students/alumni
- Credit unions offering data sovereignty as member benefit

**Trust Networks:**
- Extended family/friend groups sharing costs
- Existing co-ops adding data sovereignty services
- Religious organizations protecting congregation privacy
- Small business consortiums pooling resources

**How It Works:**
- Communities run Cardano stake pools AND PCI compute nodes
- Members pay small fees ($5-20/month) for access
- Governance via existing S-PAL mechanisms
- Revenue sharing: node operators, maintainers, community fund
- Geographic redundancy through federation with other communities

**The Bootstrap Path:**
1. Start with existing privacy-conscious communities (Signal groups, Mastodon instances)
2. Provide turnkey node deployment (like running a Minecraft server, not a data center)
3. Communities can start with one shared node, scale as needed
4. Federation protocols let communities back each other up

**This solves multiple problems:**
- **Technical:** Grandma doesn't run servers; her church/library/community does
- **Economic:** Shared costs make it affordable; creates local jobs
- **Social:** Builds on existing trust networks rather than creating new ones
- **Resilience:** Multiple community nodes prevent single points of failure
- **Sovereignty:** Your community, your rules, your governance

**Security Through Transparency (vs. "Security Through Obscurity"):**
- **Physical Access Concerns:** Yes, community servers don't have AWS-level guards
- **Our Approach:** 
  - Full disk encryption (data useless even with physical access)
  - Cryptographic attestation (prove no tampering)
  - Distributed architecture (no single point of compromise)
  - Community oversight (multiple keyholders, access logs)
  - Insurance/bonding for operators
- **Key Insight:** AWS hides breaches; communities can't

**Already Happening - Real Examples:**
- **El Servidor del Barri (Barcelona):** Neighborhood server running Nextcloud, email, Vaultwarden, calendars
- **Community Box (UK):** BBC-covered initiative bringing local cloud to rural areas
- **NYC Mesh:** Community internet expanding into local services
- **Guifi.net (Catalonia):** 39,000+ nodes proving community infrastructure works
- **Detroit Community Technology Project:** Building digital stewardship locally

**Efficiency Mechanisms:**
- **Proof Caching:** Common proofs computed once, reused many times
- **Proof Markets:** Specialized providers compete to generate proofs (paid via x402)
- **Community Proof Pools:** Communities can share cached proofs, reducing redundant computation
- **Lazy Evaluation:** Only generate proofs when actually needed
- **Progressive Enhancement:** Basic privacy works without heavy compute, advanced features scale up

**Note:** We're building on Proof-of-Stake chains (Cardano) not Proof-of-Work. The energy argument against crypto doesn't apply here - a Cardano transaction uses less energy than a Google search. A community node uses less power than a coffee shop's WiFi router.

### The UX Revolution

**Making S-PAL Invisible:**

**Natural Language Policies:**
```
User says: "Never share my health data, except proof I'm vaccinated for travel"
Local AI converts to S-PAL policy automatically
```

**Template Library:**
- Pre-built policies for common scenarios
- Community-contributed templates (verified safe)
- One-click privacy: "Student", "Job Seeker", "Patient", "Investor"

**Policy Testing Sandbox:**
- "What would happen if CNN.com asked for my email?"
- Visual flow showing: Request → Policy Check → Result
- See exactly what gets shared or blocked

**Progressive Disclosure:**
- Start simple: "High/Medium/Low Privacy"
- Power users can dive into fine-grained controls
- Natural language explanations for every setting

**Shared Policy Platform:**
- Policies are non-PII and shareable
- Upvote/downvote community templates
- Expert-reviewed "verified safe" badges
- Warning system for suspicious policies

---

## Governance: Keeping It Simple, Keeping It Sovereign

### The Anti-Fatigue Principle

We've learned from blockchain governance failures: too many votes = nobody votes. Our approach:

**Three Tiers of Decisions:**

1. **Core Protocol** (Vote rarely - maybe once a year)
   - Fundamental changes to S-PAL structure
   - Requires 67% supermajority
   - 3-month discussion period

2. **Template Standards** (Delegated voting)
   - New official policy templates
   - Handled by elected Working Groups
   - Users can delegate their vote to experts they trust

3. **Daily Operations** (No vote needed)
   - Bug fixes, documentation, minor improvements
   - Handled by maintainer teams
   - Transparent but doesn't need consensus

### Preventing Corporate Capture

**Safeguards:**
- **Identity Verification:** One human = one vote (via ZKP, not KYC)
- **Contribution Weight:** Active developers/contributors get higher weight
- **Community Node Bonus:** Communities running infrastructure get collective voting power
- **Transparency Requirements:** All funding sources public
- **Anti-Lobby Provisions:** Corporate entities can contribute but can't vote
- **Rotation Requirements:** Working group members serve max 2-year terms

**Community Governance Integration:**
- Communities running nodes automatically get representation
- Can delegate their collective vote to technical experts they trust
- Creates natural balance between users, developers, and infrastructure providers
- Prevents both corporate capture AND technocracy

### Working Groups (Focused, Not Sprawling)

Instead of committees for everything, just five focused groups:
1. **Healthcare** - Medical privacy standards
2. **Financial** - Banking/investment policies  
3. **Social** - Social media/communication
4. **Employment** - Work-related data sharing
5. **Core** - Protocol development

### The S-PAL Improvement Process (Keep It Light)

Inspired by Cardano CIPs but simpler:

1. **Propose:** Submit SPIP (S-PAL Improvement Proposal) via GitHub
2. **Discuss:** 30-day community feedback period
3. **Refine:** Working Group reviews and suggests improvements
4. **Vote:** If needed, token-weighted vote (most SPIPs shouldn't need this)
5. **Implement:** Automatic integration into reference implementations

**The Key:** Most users never need to think about governance. It just works. Power users who care can participate deeply.

---

## Core Concepts: The PCI Toolkit

The Personal Context Infrastructure (PCI) relies on merging technologies from two domains: **Self-Sovereign Identity** and **Private, Local Compute.**

### Zero-Knowledge Proofs (ZKPs)

- **What They Are:** Cryptographic methods that allow one party (the prover—your agent) to prove to another party (the verifier—the external service) that a statement is true, **without revealing any information beyond the validity of the statement itself.**
- **PCI Role:** The **Trust Bridge** (Layer 4). They are the core mechanism that prevents the "Context Devourer."
  - *Analogy:* Proving you have over $50,000 in your account **without** showing your bank statement or the exact balance.

### Distributed IDs (DIDs)

- **What They Are:** A new type of global identifier that does not require a centralized registry (like a government or Google). DIDs are anchored to a decentralized ledger (like Cardano) and are owned and controlled entirely by the user.
- **PCI Role:** The **Identity Anchor** for the **Sovereignty Layer** (Layer 3). They establish **Self-Sovereign Identity (SSI)**.
  - *The Distinction:* Your **Root DID** is your permanent identity, while an **Ephemeral DID** (a single-use key derived from your Root) is what is actually presented to external services to ensure transactions can't be linked back to your master profile.

### Smart Contracts

- **What They Are:** Self-executing contracts with the terms of the agreement directly written into code on a blockchain (like Cardano's Validator Scripts).
- **PCI Role:** The **Law** for the **Sovereignty Layer** (Layer 3). They enforce your **Sovereign Privacy & Access Language (S-PAL)** - your machine-readable privacy policy.
  - *System Enforcement:* The smart contract acts as an immutable gatekeeper, returning `True` or `False`. If access violates your S-PAL (e.g., the service requests data retention when your S-PAL mandates `0_Seconds`), the contract fails, and the interaction becomes mathematically impossible.

### Distributed Databases (DBs) & Sync Engines

- **What They Are:** Database systems where data is spread across multiple nodes or devices, often designed for resilience, local-first operation, and sync capabilities.
- **PCI Role:** The **Memory** for the **Context Store** (Layer 1). They ensure your context is available, consistent, and encrypted across your own ecosystem of devices.
  - **Yjs:** This battle-tested CRDT framework fits as a *type* of **Encrypted Sync Engine**. It offers the essential features needed for the PCI: device-level encryption, real-time synchronization of data and files, and built-in permissions, making it an ideal candidate for your **Personal Context Store** (Vault).

---

## The Architecture: The Sovereign Stack

This is not science fiction. It is a combination of four existing technologies reassembled to protect the user.

### Layer 1: The Memory (Context Store)

- **The Capability:** A secure, encrypted-at-rest vault that syncs across your devices but looks like static to the cloud.
- **The Tech:** **Yjs** (Encrypted Sync Engines) or similar local-first database solutions.
- **The Rule:** Data exists here and *only* here. It is the home of your vector embeddings—the mathematical map of your life.

### Layer 2: The Workforce (Personal Agent)

- **The Capability:** A localized AI that lives on your hardware (laptop, phone, or home server). It "thinks" using your data but never leaks the thought process.
- **The Tech:** **Local SLMs** (Qwen3.6-27B, Phi-4 (14B), Bonsai 27B — PrismML's Apache-2.0 ternary distillation that runs on a phone at 5.9 GB) run via **Ollama** (default), or **WASM Agents** running directly in your browser. For speech: **Mistral Voxtral** (4B params, runs on phone) or **NVIDIA Nemotron** (600M params, streaming).
- **The Reality:** This already works - iPhone 15 Pro runs 3B models, WebAssembly brings compute anywhere. Open-source speech models now transcribe locally without sending audio to remote servers.

### Layer 3: The Law (Sovereignty Layer)

- **The Capability:** The immutable enforcement of your "Non-Negotiables." It prevents any interaction that violates your set rules.
- **The Tech:** **Cardano Smart Contracts** (using **Aiken** or **Helios**).
  - **Aiken:** A modern, Rust-like language built specifically for safety and ease of use.
  - **Helios:** A language that compiles to Cardano but looks and feels like **TypeScript**.
- **The Mechanism:** These scripts act as automated gatekeepers. They validate the transaction state against your S-PAL. If a service requests data retention but your S-PAL dictates `0s`, the script returns `False`. The transaction fails, and the data access becomes physically impossible.

### Layer 4: The Trust Bridge (Verification)

- **The Capability:** Proving a fact to the outside world without revealing the context behind it.
- **The Tech:** **Midnight** Zero-Knowledge Proofs (contracts written in **Compact**) & **Ephemeral DIDs**.
- **The Developer Experience:** Midnight contracts use **Compact**, a domain-specific language designed for privacy.
  - **Why it matters:** Compact integrates natively with **TypeScript**. This allows web developers to define "public" and "private" state easily, bridging the gap between standard web apps and Zero-Knowledge cryptography without requiring a PhD in math.
- **The Antidote to Shadow Profiles:** This layer uses the logic defined in Compact to generate **Ephemeral DIDs**—temporary, single-use identities. Companies see a "verified user" enter and leave, but they cannot track that user across different sessions. It kills the Shadow Profile.

---

## The Competitive Landscape: Building on Giants' Shoulders

### Why PCI, Not Just Another Privacy Tool?

**Existing Efforts & How We Differ:**

| **Project** | **What They Do** | **What's Missing** | **How PCI Builds On It** |
|------------|------------------|-------------------|-------------------------|
| **Solid (Tim Berners-Lee)** | Data pods where users control access, recently moved to ODI stewardship (Oct 2024) | No ZKPs, no smart contract enforcement, requires trust in pod hosts, struggling with developer adoption | Add cryptographic enforcement + proof layer |
| **Polygon ID** | Zero-knowledge identity with selective disclosure | Identity only, no broader context management or data storage | Use for identity layer, add context management |
| **Sovrin/uPort** | Self-sovereign identity on blockchain | Identity only, no compute or storage layer | Identity feeds our sovereignty system |
| **DIDComm** | Secure messaging between DIDs | Communication protocol only, no data sovereignty | Use for agent-to-service negotiation |
| **Galxe** | Web3 credential network | Crypto-native only, limited to on-chain data | Expand to all personal data types |
| **Brave Browser** | Blocks trackers, local ads, BAT rewards | Defensive only, no proactive data control | Could be the ideal PCI client implementation |
| **Signal Protocol** | End-to-end encryption for messaging | Messages only, not general compute | Inspiration for local-first encryption |

**Trust Infrastructure Comparison:**

| **Project** | **What They Do** | **Gap** | **PCI Trust Registry Advantage** |
|------------|------------------|---------|--------------------------------|
| **Trust Over IP (ToIP)** | Developing Trust Registry Query Protocol—standards for querying trust data | Standards only, no commercial platform | We implement their protocol in a usable platform |
| **EU eIDAS 2.0** | Trusted Issuer Registries, Digital Identity Wallets for Europe | EU-only, government-led, slow | We aggregate globally, add S-PAL compliance |
| **W3C VCs/DIDs** | Standardized credential and identifier formats | No discovery mechanism for issuers/verifiers | We provide the discovery and verification layer |
| **EU Trusted Lists (EUTL)** | 200+ accredited Trust Service Providers for eIDAS | Limited to EU-qualified providers only | We extend to global provers with S-PAL compliance |

**Key Differentiators:**

1. **Full Stack Solution:** Unlike Solid (storage-focused) or Polygon ID (identity-focused), PCI integrates all four layers
2. **Cryptographic Enforcement:** S-PAL policies are mathematically enforced via smart contracts, not honor-system based
3. **Local-First Architecture:** Your agent and data live on YOUR hardware, not someone else's "pod server"
4. **Economic Integration:** x402 micropayments make the model sustainable without surveillance
5. **Developer Accessibility:** TypeScript/Rust tooling instead of academic languages or complex blockchain APIs

**Learning from Solid's Struggles:**

Solid's adoption has been limited by requiring users to trust pod hosts and lacking clear developer tools. In October 2024, the Open Data Institute took stewardship of Solid to accelerate development, signaling both the project's importance and its challenges.

PCI addresses these gaps:
- **No Pod Host Trust:** Your data lives on YOUR devices via Yjs, not third-party servers
- **Clear Developer Path:** S-PAL provides concrete policies, not abstract permissions
- **Immediate Value:** Works partially even without full ecosystem adoption

---

## The Economy: Beyond "Free"

### The Real Cost of "Free" Services

Current model:
- Google Photos: "Free" = They train AI on your family photos
- Gmail: "Free" = They scan your emails for ad targeting
- Facebook: "Free" = You are the product being sold

**The Hidden Invoice:**
- Average user generates ~$200/year in data value for Big Tech
- You pay with privacy, autonomy, and digital sovereignty
- The cost compounds: today's data trains tomorrow's replacement

### The PCI Economic Model

**Micropayments Make Macro Sense:**

| **Interaction** | **Old Model** | **PCI Model** | **User Cost/Month** |
|----------------|--------------|---------------|-------------------|
| Read 100 articles | View ads, tracked | Pay $0.002 each | $0.20 |
| 500 web searches | Search history sold | Pay $0.001 each | $0.50 |
| Stream 1000 songs | Profile monetized | Pay $0.003 each | $3.00 |
| **Total** | **Surveillance** | **Sovereignty** | **~$5-10** |

**Why This Works:**
- Creators get paid directly (often MORE than ad revenue)
- No middleman taking 30-70% cut
- No perverse incentives for engagement manipulation
- Privacy becomes the DEFAULT, not premium feature

### The Bootstrap Economy

**Phase 1: Community Formation**
- First 100 community nodes get setup grants
- Communities of 50-500 members share infrastructure costs
- $10-20/member/month funds local node operators
- Creates local tech jobs and expertise

**Phase 2: Network Effects**
- Communities federate for resilience and resource sharing
- Privacy-conscious services preferentially support community nodes
- Local businesses sponsor community infrastructure
- Proof markets emerge between communities

**Phase 3: The New Normal**
- Community data sovereignty becomes expected (like community broadband)
- Local governments run public nodes (like libraries provide internet)
- Schools teach data sovereignty using community infrastructure
- Data exploitation becomes competitively disadvantageous

**Community Cloud Economics:**

| **Model** | **Cost/Month** | **Who Runs It** | **Governance** | **Best For** |
|-----------|---------------|----------------|---------------|-------------|
| Solo Device | $0 | You | Full Control | Tech savvy individuals |
| Family Node | $20 total | Tech-savvy family member | Family council | Small trust groups |
| Community Node | $10/person | Local tech co-op | Community board | Neighborhoods, orgs |
| Federation | $5/person | Professional operators | Delegated voting | Large scale adoption |

This creates a **sustainable local economy**:
- Node operators earn steady income
- Communities retain wealth locally
- Technical expertise develops organically
- Privacy becomes affordable for everyone

---

## The Standard: S-PAL (Sovereign Privacy & Access Language)

S-PAL is your machine-readable Bill of Rights—the code that your Sovereignty Layer enforces. It defines how your data can be accessed, by whom, for what purpose, and under what conditions.

### Narrative Example: The "Job Application"

Imagine applying for a job without uploading a resume that reveals your age, gender, or address.

1. **The Request:** The employer's system requests verification of your qualifications.
2. **S-PAL Activated:** Your agent checks your S-PAL policy for "Employment_Verification."
3. **Zero-Knowledge Generation:** Your **Trust Bridge** creates proofs:
   - Proof of degree from accredited university (not which one)
   - Proof of 5+ years experience in field (not company names)
   - Proof of professional certification (not certificate number)
4. **Ephemeral Identity:** A single-use DID is generated for this application only.
5. **Transaction:** The employer gets verified facts. You keep your privacy. Both win.

### Technical Example: Health Records Access

S-PAL creates **active, undeniable contracts** that your **Sovereignty Layer** enforces:

| **S-PAL Policy Field** | **Value / Non-Negotiable**    | **Philosophical Meaning**                                    |
| ---------------------- | ----------------------------- | ------------------------------------------------------------ |
| **Policy Name**        | `Health-Records-V2`           | Human-readable identifier for your policy.                   |
| **Context_Scope**      | `Medical/Diagnosis_Codes`     | Specifies the data subset to access in the **Context Store** (Layer 1). |
| **Identity_Linkage**   | **`Ephemeral-Mandatory`**     | **Non-Negotiable:** Must use a single-use DID. Prevents **Shadow Profiles**. |
| **Proof_Requirement**  | `ZKP-Has-Allergies: False`    | Requires a Zero-Knowledge Proof that you *do not* have a specific condition. |
| **Derivative_Use**     | `Forbidden: Any_Training_Set` | **Non-Negotiable:** The service cannot capture any element for model training. |
| **Data_Retention**     | `0_Seconds`                   | **Non-Negotiable:** Cryptographic deletion immediately upon validation. |
| **Payment_Protocol**   | `x402: Required`              | Micro-payment required for validation cost. |

---

## User Journeys: Liberation in Practice

### Journey 1: The Insurance Renewal (Today vs Tomorrow)

| **Step**            | **Today (Surveillance)** | **Tomorrow (Sovereignty)** |
|--------------------|------------------------|--------------------------|
| **Initial Request** | Insurer demands full driving history, GPS tracking, income docs | Insurer requests risk assessment proofs |
| **Your Action** | Install tracking app, share location 24/7, email pay stubs | Agent generates ZKPs from local data |
| **What They Get** | Your exact routes, speed, income, employer, home address | Proofs: safe driver, low mileage, adequate income |
| **What You Pay** | Your privacy and autonomy | $0.01 in x402 for verification |
| **Long-term Impact** | Permanent profile, data sold to others, used against you | Zero data retained, no profile possible |

### Journey 2: The Creative Professional

You're a writer. Your style is your livelihood. An AI company wants to train on your work.

**Today:** They scrape your blog, clone your voice, sell it back to your clients for less.

**PCI Future:**
1. Your S-PAL marks all creative output with your Content DID
2. Any derivative work is cryptographically linked to you
3. Smart contract ensures you get paid for every use
4. You can prove plagiarism mathematically
5. Your digital creativity becomes actual property

---

## The Resilience Reality Check: Learning from Cardano's "Poison Piggy"

### Why Local-First Architecture Matters

On November 21, 2025, Cardano experienced a 14-hour degradation of service due to a serialization bug that created a chain fork. Transactions were delayed by up to 400 seconds, and roughly 3.3% (479 out of 14,383) of transactions didn't make it into the dominant fork.

**This incident validates our local-first approach:**

**The Problem:** A bug caused nodes to disagree on transaction validity, creating two competing versions of the blockchain. Services relying purely on blockchain state were disrupted.

**The PCI Advantage:**
- **Your Context Store (Layer 1) and Personal Agent (Layer 2) run locally** - they keep functioning regardless of blockchain issues
- **You can still:** Query your data, generate reports, make local decisions, prepare transactions
- **You only wait for:** Final cryptographic verification when the network recovers

**Key Insight:** We don't build ON the chain; we build WITH the chain as an anchor. Your digital sovereignty doesn't depend on 100% blockchain uptime.

This is why Yjs (local-first sync) isn't optional - it's mission-critical. If we stored everything on-chain, a network disruption would lock you out of your own life. By keeping data local and only using blockchain for enforcement and verification, you maintain sovereignty even during network issues.

**The Lesson:** The chain recovered organically in 14 hours through social consensus and SPO coordination. But users with local-first architectures never lost access to their data. This makes PCI more mature than typical "Web3 fixes everything" proposals - we understand that resilience comes from NOT depending entirely on any single system.

---

## The Trust Registry: Making Provers Discoverable

### The Missing Piece for Business Adoption

For PCI to work at scale, businesses need to know: *Which proof providers can I trust?* Users need confidence that their PCI wallet will work with legitimate verification services.

**The Problem:**
- Which age verification provider should a UK business use for German customers?
- How do businesses know a prover respects S-PAL policies?
- How do different countries' regulatory requirements map to available provers?

**The Solution: A Global Trust Registry**

We propose a blockchain-anchored registry of approved third-party proof providers, with user-friendly discovery platforms built on top:

| Layer | What It Does |
|-------|-------------|
| **On-Chain (Cardano)** | Immutable registry entries: prover DIDs, proof types, jurisdictions, S-PAL compliance attestations, status |
| **Off-Chain Platforms** | Business portal, AI-powered discovery, developer APIs, regulatory monitoring |

This follows our "anchors to the chain" philosophy—the source of truth is on-chain, but the user experience is delivered through conventional platforms.

### Building on Existing Standards

We're not starting from scratch. The Trust Registry builds on:

- **Trust Over IP (ToIP) TRQP**: Their Trust Registry Query Protocol defines how to query trust registries—we implement it
- **EU eIDAS 2.0**: Europe's Trusted Issuer Registries provide government-backed authority—we aggregate and extend
- **W3C VCs/DIDs**: Standard formats for credentials and identifiers—we use them throughout

### The Business Model

| Revenue Stream | Who Pays |
|---------------|----------|
| Prover registration fees | Provers (listing + certification) |
| API access tiers | Businesses (volume-based) |
| Premium discovery (AI recommendations) | Businesses (subscription) |
| Dispute resolution | Disputants |

This creates a **sustainable B2B revenue engine** that can fund consumer-facing PCI development.

**Full details:** See [Trust Registry](trust-registry.md) for complete architecture, governance model, and implementation roadmap.

---

## Reality Check: The Path Forward

### Technical Readiness (2024-2025)

✅ **Ready Now:**
- Local models run on phones (iPhone 15, Pixel 8)
- WebAssembly agents work in any browser
- Cardano/Midnight infrastructure deployed
- x402 payment protocol functional

⏳ **Coming Soon (6-12 months):**
- Dedicated AI chips in most devices
- One-click PCI deployment tools
- First wave of PCI-native services
- S-PAL standard v1.0 finalization

🔮 **Future (12-24 months):**
- PCI built into operating systems
- Major services offer S-PAL compatibility
- Regulatory recognition of S-PAL policies
- Network effects reach critical mass

### The "But What About Crime?" Defense

Critics claim privacy enables crime. **We already solved this:**

**Selective Disclosure via View Keys:**
- Court orders can mandate specific view access
- Regulatory compliance without mass surveillance
- Audit trails for legitimate investigations
- Zero-knowledge proofs of non-criminality

**Example:** Prove you paid taxes without revealing income sources. Prove you're not laundering money without showing all transactions.

**The Principle:** Accountability without surveillance. Transparency where required, privacy by default.

---

## Call to Action: Join the Resistance

### For Communities & Organizations
- Run a community node (we'll help with setup)
- Libraries: Offer data sovereignty like you offer internet
- Co-ops: Add PCI to your member services
- Universities: Protect student/researcher privacy
- Credit unions: Differentiate with financial data sovereignty

### For Developers
- Build S-PAL tooling (bounties available)
- Create PCI-compatible services
- Contribute to governance discussions
- Port existing apps to respect sovereignty
- Build community node management tools

### For Early Adopters
- Run the browser extension (Phase 1)
- Join or start a local community node
- Demand S-PAL support from services
- Share your policies, help others
- Vote with your data AND your wallet

### For Services & Businesses
- Implement S-PAL acceptance (we'll help)
- Advertise sovereignty compliance
- Partner with community nodes
- Compete on privacy, not exploitation
- Join the post-surveillance economy

### For Everyone
- Your data is your digital soul
- You deserve mathematical privacy
- Communities can provide sovereignty
- The tools exist TODAY
- The revolution needs you

---

## Next Steps

1. **Join the Movement:** [GitHub repo link] / [Discord] / [Website]
2. **Run the Alpha:** Browser extension available now
3. **Build With Us:** S-PAL SDK documentation ready
4. **Spread the Word:** Share this manifesto

We are not asking for permission. We are taking back control.

**The machine has been devouring our context long enough.**
**It's time to reclaim the ghost.**

---

### References

1. **Chitnis, Apurva & Esber, Jad.** "Personal Context Infrastructure" (PCI). *koodos Labs Blog*.
   - Available at: https://blog.koodos.com/p/personal-context-infrastructure
   - *(Credited for coining the term Personal Context Infrastructure)*

2. **Abi-Esber, Nicole, et al.** (2025). "Beyond Digital Exhaust: Reclaiming Agency in the Context Economy." *MozFest Barcelona*.
   - Available at: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5800362
   - *(Mozilla AI, Koodos, and collaborators on the context economy and personal context infrastructure)*

3. **Feigenbaum, Edward A., et al.** (2015). "Privacy in a World of Pervasive Data." *AI Magazine*, 36(2).
   - Available at: https://onlinelibrary.wiley.com/doi/epdf/10.1609/aimag.v36i2.2586
   - *(Establishing the academic challenge of balancing data utility with individual rights)*

4. **314 Pool.** (2025). "Poison Piggy - After Action Report".
   - Available at: https://www.314pool.com/post/cardano-post-mortem-2
   - *(Analysis of Cardano's November 2025 network disruption, demonstrating resilience)*

5. **Open Data Institute & Solid Project.** (2024). "ODI and Solid Come Together".
   - Available at: https://theodi.org/news-and-events/news/odi-and-solid
   - *(Solid stewardship transition and evolution)*

6. **Cardano Documentation.** "Smart Contract Languages Overview".
   - Available at: https://developers.cardano.org/docs/smart-contracts/
   - *(Technical foundation for smart contract implementation)*

7. **Midnight Network.** "Privacy-Preserving Blockchain".
   - Available at: https://midnight.network/
   - *(Zero-knowledge proof infrastructure)*

8. **Yjs Documentation.** "Local-First Collaborative Software".
   - Available at: https://docs.yjs.dev/
   - *(Distributed database architecture and encrypted sync)*

9. **Helios Language.** "TypeScript-like Smart Contracts for Cardano".
   - Available at: https://www.hyperion-bt.org/helios-book/
   - *(Accessible smart contract development)*

10. **Aiken Language.** "Modern Smart Contracts for Cardano".
    - Available at: https://aiken-lang.org/
    - *(Rust-like language for those preferring type safety)*

11. **plu-ts.** "TypeScript Smart Contracts for Cardano".
    - Available at: https://pluts.harmoniclabs.tech/
    - *(Native TypeScript for blockchain development)*

12. **x402 Protocol.** "HTTP Payment Protocol Specification".
    - Available at: https://github.com/Cameri/awesome-nostr (includes x402 implementations)
    - *(Micropayment infrastructure for agent commerce)*

13. **W3C DID Specification.** "Decentralized Identifiers v1.0".
    - Available at: https://www.w3.org/TR/did-core/
    - *(Standard for self-sovereign identity)*

14. **Guifi.net.** "The Barcelona WiFi Network".
    - Available at: https://guifi.net/en
    - *(Proof of community network scalability - 39,000+ nodes)*

15. **El Servidor del Barri.** "Neighborhood Server Project".
    - Mozilla Festival 2025 Presentation
    - Contact: admin@barri.elmercatcultural.cat
    - *(Real-world community infrastructure implementation)*

16. **Community Box Project.** "Rural Community Cloud Infrastructure".
    - BBC Coverage: https://www.bbc.co.uk/news/articles/c0rpy7envr5o
    - *(UK deployment of local cloud services)*

17. **Trust Over IP Foundation.** "Trust Registry Query Protocol V2.0".
    - Available at: https://trustoverip.github.io/tswg-trust-registry-protocol/
    - *(Standard for querying trust registries—"DNS for trust")*

18. **EU eIDAS 2.0.** "European Digital Identity Framework".
    - Regulation (EU) 2024/1183
    - *(Trusted Issuer Registries and Digital Identity Wallets)*

19. **Raidiam Developers.** "What Is a Trust Registry?"
    - Available at: https://www.raidiam.com/developers/blog/trust-registries-in-scalable-digital-trust
    - *(Overview of trust registry concepts and necessity)*

20. **Mistral AI.** "Voxtral Transcribe 2".
    - Available at: https://mistral.ai/news/voxtral-transcribe-2
    - HuggingFace: https://huggingface.co/mistralai/Voxtral-Mini-3B-2507
    - *(Open-source speech-to-text, 4B params, runs on-device, Apache 2.0 license)*

21. **NVIDIA.** "Nemotron Speech Streaming".
    - Available at: https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b
    - *(600M param streaming ASR, NVIDIA Open Model License)*

22. **BBC News.** "AI Chatbots Unable to Accurately Summarise News" (2025).
    - Available at: https://www.bbc.co.uk/news/articles/c8x9x8ldvk2o
    - *(Research showing 51% of AI-generated summaries had significant inaccuracies - evidence for local-first, trustworthy AI)*

---
