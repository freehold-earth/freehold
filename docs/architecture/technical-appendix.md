# Freehold Technical Implementation Appendix

## Table of Contents
1. [System Architecture](#system-architecture)
2. [Layer 1: Context Store Implementation](#layer-1-context-store)
3. [Layer 2: Personal Agent Implementation](#layer-2-personal-agent)
4. [Layer 3: Sovereignty Layer Implementation](#layer-3-sovereignty-layer)
5. [Layer 4: Trust Bridge Implementation](#layer-4-trust-bridge)
6. [Layer 5: Identity Implementation](#layer-5-identity)
7. [Trust Registry Implementation](#trust-registry)
8. [S-PAL Specification](#s-pal-specification)
9. [Community Node Deployment](#community-node-deployment)
10. [Security Considerations](#security-considerations)
    - [Data Retention Enforcement](#data-retention-enforcement)
11. [API Specifications](#api-specifications)

---

## System Architecture

### Core Design Principles
- **Local-First:** Data lives on user/community devices, not cloud
- **Cryptographic Guarantees:** Math enforces privacy, not policies
- **Progressive Enhancement:** Works partially without full stack
- **Federation Ready:** Communities can interconnect

### Technology Stack Overview
```yaml
Layer 1 - Context Store:
  - Primary: Yjs (battle-tested CRDT framework, 1.9M weekly downloads)
  - Vectors: sqlite-vec (embedded vector search)
  - Future: Jazz (when mature - see ADR-001)
  - Encryption: AES-256-GCM at rest
  - Sync: CRDTs for conflict resolution

Layer 2 - Personal Agent:
  - Local Models: Qwen3.6-27B, Phi-4 (14B), Phi-4-mini (3.8B), Bonsai 27B (5.9 GB ternary / 3.9 GB 1-bit, PrismML, Apache 2.0)
  - Runtime: llama.cpp family (`llama-server`, llamafile) by default; Ollama optional; any OpenAI-compatible server (ADR-006)
  - Structured output: XGrammar (vLLM/SGLang) or llama.cpp built-in JSON-schema → GBNF
  - Deployment: Electron app, browser extension (thin client to a local agent), mobile app (thin client), native on-device client (ADR-006 track 2), llamafile single-executable bundle
  - Community: Docker containers on shared hardware

Layer 3 - Sovereignty Layer:
  - Blockchain: Cardano (Plutus v3)
  - Smart Contracts: Aiken validators (ADR-003), TypeScript off-chain package
  - Standards: S-PAL (Sovereign Privacy & Access Language)

Layer 4 - Trust Bridge:
  - ZKP Framework: Midnight (Compact language)
  - Circuits: Circom for custom proofs
  - Libraries: snarkjs, libsnark

Layer 5 - Identity:
  - Root: W3C DIDs, `did:key` held locally; `did:midnight` via Passport planned (ADR-008)
  - Ephemeral: single-use DIDs per interaction, linked to the root by signed authorisation records
  - Package: identity/ (TypeScript)

Trust Registry (cross-cutting service):
  - On-Chain: Cardano smart contracts (prover registry)
  - Off-Chain: REST/GraphQL API, Business Portal
  - Discovery: AI-powered classification and recommendation
  - Standards: ToIP TRQP compatible, eIDAS interoperable
```

---

## Layer 1: Context Store

### Data Model
```typescript
interface ContextStore {
  // Core identity
  rootDID: string;
  publicKey: CryptoKey;

  // Encrypted vaults
  vaults: {
    personal: EncryptedVault;
    health: EncryptedVault;
    financial: EncryptedVault;
    professional: EncryptedVault;
    custom: Map<string, EncryptedVault>;
  };

  // Vector embeddings for semantic search
  embeddings: {
    documents: Float32Array[];
    metadata: EmbeddingMetadata[];
  };

  // Sync configuration
  sync: {
    peers: PeerConnection[];
    conflictResolution: CRDTStrategy;
    backupLocations: BackupEndpoint[];
  };
}
```

### Yjs Implementation Example
```typescript
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';

class ContextNode {
  private doc: Y.Doc;
  private vaults: Y.Map<Y.Map<unknown>>;
  private persistence: IndexeddbPersistence;
  private syncProvider?: WebsocketProvider;

  constructor(userId: string) {
    this.doc = new Y.Doc();
    this.vaults = this.doc.getMap('vaults');

    // Local persistence (browser)
    this.persistence = new IndexeddbPersistence(`pci-${userId}`, this.doc);
  }

  // Enable sync with self-hosted server
  enableSync(serverUrl: string) {
    this.syncProvider = new WebsocketProvider(serverUrl, 'pci-room', this.doc);
  }

  async addDocument(vaultName: string, doc: Document) {
    let vault = this.vaults.get(vaultName);
    if (!vault) {
      vault = new Y.Map();
      this.vaults.set(vaultName, vault);
    }

    // Generate embedding (via sqlite-vec)
    const embedding = await this.generateEmbedding(doc);

    // Store encrypted content
    vault.set(doc.id, {
      content: await encrypt(doc.content, this.encryptionKey),
      embedding: embedding,
      metadata: doc.metadata,
      updatedAt: Date.now()
    });
  }

  // Observe changes for reactivity
  observe(callback: (events: Y.YEvent<any>[]) => void) {
    this.vaults.observeDeep(callback);
  }
}
```

### Storage Requirements
- **Minimum:** 10GB encrypted storage per user
- **Recommended:** 100GB for full context history
- **Bandwidth:** 10 Mbps for real-time sync
- **Redundancy:** 3x replication across devices/nodes

---

## Layer 2: Personal Agent

### Local SLM Deployment
```python
# Using llama.cpp for efficient inference
import llama_cpp
import numpy as np
from typing import List, Dict

class PersonalAgent:
    def __init__(self, model_path: str):
        self.llm = llama_cpp.Llama(
            model_path=model_path,
            n_ctx=4096,  # Context window
            n_gpu_layers=35,  # GPU acceleration if available
            n_threads=8
        )
        self.context_store = ContextStore()

    def process_request(self, request: str, policy: SPALPolicy):
        # Retrieve relevant context
        context = self.context_store.semantic_search(request)

        # Check S-PAL policy
        if not policy.allows_access(context):
            return None

        # Generate response
        response = self.llm(
            f"Context: {context}\nRequest: {request}",
            max_tokens=512,
            temperature=0.7
        )

        # Audit log
        self.log_interaction(request, response, policy)

        return response
```

### Community Node Agent Architecture

Schematic. `infra/docker-compose.yml` is the stack that runs; it names the model the same way (`MODELS_DIR`, `MODEL_FILE`).

```yaml
services:
  # Only the gateway publishes a port. Internal services are reached by name on
  # the compose network; a published port would bypass host firewalls (ufw).
  # Every link carries TLS from the stack's own CA (infra/scripts/certs.sh),
  # loopback included; the agent trusts the CA and nothing else beyond the
  # system store. The agent and llama-server share a network of their own:
  # prompts and the bearer token cross it, and no other container joins it.
  llama-server:
    image: ghcr.io/ggml-org/llama.cpp:server
    # Community-tier default: Qwen3.6-27B (Q4-class, ~17 GB) served by
    # llama-server, which makes no outbound calls (ADR-006). Bonsai-27B 1-bit
    # is the low-RAM fallback once mainline llama.cpp's Q1_0 kernels land.
    # Slots, web UI and unauthenticated access stay off (see Threat Model), and
    # the link carries TLS even on one host: the agent refuses plain HTTP.
    command: ["-m", "/models/${MODEL_FILE}", "--host", "0.0.0.0", "--port", "8080",
              "--no-slots", "--no-webui", "--api-key-file", "/run/secrets/llama_api_key",
              "--ssl-key-file", "/run/secrets/llama_ssl_key",
              "--ssl-cert-file", "/run/secrets/llama_ssl_cert"]
    volumes:
      - ${MODELS_DIR:-./models}:/models:ro
    networks: [inference]

  agent-orchestrator:
    image: freehold/agent-orchestrator:latest
    networks: [default, inference]
    volumes:
      - ./contexts:/contexts
    environment:
      - MAX_CONCURRENT_AGENTS=100
      - FREEHOLD_LLM_BACKEND=http
      - FREEHOLD_LLM_URL=https://llama-server:8080/v1
      - FREEHOLD_CA_FILE=/run/secrets/ca_cert
      - FREEHOLD_TLS_CERT_FILE=/run/secrets/agent_cert
      - FREEHOLD_TLS_KEY_FILE=/run/secrets/agent_key
      - COMMUNITY_ID=${COMMUNITY_ID}

  load-balancer:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - agent-orchestrator

networks:
  inference: {}
```

---

## Layer 3: Sovereignty Layer

### S-PAL Smart Contract (Aiken)
```rust
use aiken/hash.{Blake2b_224, Hash}
use aiken/list
use aiken/transaction.{ScriptContext}

type SPALPolicy {
  owner: Hash<Blake2b_224, VerificationKey>,
  rules: List<AccessRule>,
  version: Int,
}

type AccessRule {
  context_scope: ByteArray,
  identity_requirement: IdentityType,
  retention_limit: Int,  // seconds
  derivative_forbidden: Bool,
  payment_required: Int, // lovelace
}

validator spal_enforcer {
  fn enforce(policy: SPALPolicy, ctx: ScriptContext) -> Bool {
    // Check signature
    let tx = ctx.transaction
    expect Some(signature) = list.find(
      tx.extra_signatories,
      fn(sig) { sig == policy.owner }
    )

    // Validate access rules
    expect Some(access_request) = decode_access_request(tx.metadata)

    // Check each rule
    list.all(
      policy.rules,
      fn(rule) { validate_rule(rule, access_request) }
    )
  }
}
```

### DID Implementation
```typescript
interface PCI_DID {
  // Root DID (permanent identity)
  root: {
    id: string;  // did:key:z6Mk... (chain-agnostic; did:key today, did:midnight via Passport planned, did:prism alternative — ADR-008)
    publicKey: JsonWebKey;
    privateKey: CryptoKey;  // Never leaves device
    created: Date;
  };

  // Ephemeral DIDs (single-use)
  ephemeral: {
    generate(): Promise<EphemeralDID>;
    derive(nonce: Uint8Array): EphemeralDID;
    revoke(did: string): void;
  };
}

class DIDManager {
  async createEphemeralDID(purpose: string): Promise<EphemeralDID> {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const derived = await this.deriveKey(this.rootKey, nonce);

    return {
      id: `did:key:z${base58(derived.public)}`,  // pci-identity ephemeral DID format
      publicKey: derived.public,
      privateKey: derived.private,
      validUntil: Date.now() + 3600000, // 1 hour
      purpose,
      parent: this.rootDID
    };
  }
}
```

---

## Layer 4: Trust Bridge

### Zero-Knowledge Proof Generation (Midnight/Compact)
```typescript
// Compact contract for age verification
contract AgeVerification {
  // Private state (never revealed)
  @shielded birthDate: Date;
  @shielded documentHash: Bytes32;

  // Public state (visible on-chain)
  @transparent verificationCount: Integer;

  // Circuit: Prove age without revealing birthdate
  circuit proveOver18(currentDate: Date): Boolean {
    assert(currentDate.year - this.birthDate.year >= 18);
    this.verificationCount += 1;
    return true;
  }

  // Generate proof for external verification
  export function generateAgeProof(minAge: number): Proof {
    const proof = await generateProof({
      circuit: 'proveOver18',
      private_inputs: {
        birthDate: this.birthDate
      },
      public_inputs: {
        currentDate: new Date(),
        minAge: minAge
      }
    });

    return {
      proof: proof.serialize(),
      publicSignals: proof.publicSignals,
      verificationKey: this.verificationKey
    };
  }
}
```

### Proof Caching System
```python
class ProofCache:
    def __init__(self, storage_path: str):
        self.cache = {}
        self.storage = LevelDB(storage_path)

    async def get_or_generate(self, claim: Claim) -> Proof:
        # Check cache
        cache_key = self.compute_cache_key(claim)

        if cached := self.cache.get(cache_key):
            if not cached.is_expired():
                return cached

        # Check persistent storage
        if stored := await self.storage.get(cache_key):
            if not stored.is_expired():
                self.cache[cache_key] = stored
                return stored

        # Generate new proof
        proof = await self.generate_proof(claim)

        # Cache with appropriate TTL
        ttl = self.compute_ttl(claim)
        self.cache[cache_key] = CachedProof(proof, ttl)
        await self.storage.put(cache_key, proof)

        return proof
```

---

## Layer 5: Identity

### Overview
The identity layer holds one root DID per person and issues a fresh ephemeral DID for every interaction. The root is a `did:key` held locally today, with `did:midnight` via Passport as the planned anchor (ADR-008); each ephemeral DID is tied to its root by a signed authorisation record, so continuity can be proven when the person chooses and nothing links one interaction to the next otherwise. The implementation lives in `identity/` (TypeScript). Design detail is in [Identity](../concepts/identity.md) and the [Identity Privacy Model](../concepts/identity-privacy-model.md).

---

## Trust Registry

### Overview
The Trust Registry is a blockchain-anchored directory of approved proof providers (provers), with off-chain discovery platforms for business usability. It answers the question: "Which provers can I trust for this type of verification in this jurisdiction?"

### On-Chain Registry Contract (Aiken)
```rust
use aiken/hash.{Blake2b_224, Hash}
use aiken/list
use aiken/transaction.{ScriptContext, Output}

type ProverEntry {
  prover_did: ByteArray,
  legal_name: ByteArray,
  proof_types: List<ProofType>,
  jurisdictions: List<ByteArray>,
  accrediting_authority: AccreditingAuthority,
  spal_compliance: SPALCompliance,
  status: ProverStatus,
  metadata_uri: ByteArray,
  registered_at: Int,
  updated_at: Int,
}

type ProofType {
  category: ByteArray,
  specific_type: ByteArray,
  zkp_supported: Bool,
}

type AccreditingAuthority {
  authority_type: AuthorityType,
  authority_did: ByteArray,
  attestation_tx: ByteArray,
}

type AuthorityType {
  Government
  Delegated
  DAO
}

type SPALCompliance {
  version: ByteArray,
  attestation_hash: ByteArray,
  auditor_did: ByteArray,
  last_audit: Int,
}

type ProverStatus {
  Pending
  Active
  Suspended
  Revoked
}

validator trust_registry {
  fn register_prover(
    entry: ProverEntry,
    authority_sig: ByteArray,
    ctx: ScriptContext
  ) -> Bool {
    // Verify accrediting authority signature
    let authority_valid = verify_authority_signature(
      entry.accrediting_authority,
      authority_sig,
      ctx
    )

    // Verify S-PAL compliance attestation
    let spal_valid = verify_spal_attestation(
      entry.spal_compliance,
      ctx
    )

    // Verify unique DID
    let did_unique = !prover_exists(entry.prover_did, ctx)

    authority_valid && spal_valid && did_unique
  }

  fn update_status(
    prover_did: ByteArray,
    new_status: ProverStatus,
    authority_sig: ByteArray,
    ctx: ScriptContext
  ) -> Bool {
    // Only original accrediting authority can update status
    let entry = get_prover_entry(prover_did, ctx)
    verify_authority_signature(
      entry.accrediting_authority,
      authority_sig,
      ctx
    )
  }

  fn query_provers(
    proof_type: ByteArray,
    jurisdiction: ByteArray,
    ctx: ScriptContext
  ) -> List<ProverEntry> {
    // Return all active provers matching criteria
    list.filter(
      get_all_provers(ctx),
      fn(entry) {
        entry.status == Active &&
        list.any(entry.proof_types, fn(pt) { pt.category == proof_type }) &&
        list.any(entry.jurisdictions, fn(j) { j == jurisdiction })
      }
    )
  }
}
```

### TypeScript Data Models
```typescript
interface ProverRegistryEntry {
  // Identity
  prover_did: string;
  legal_name: string;

  // Capabilities
  proof_types: ProofType[];
  jurisdictions: Jurisdiction[];

  // Trust Chain
  accrediting_authority: {
    type: 'government' | 'delegated' | 'dao';
    did: string;
    attestation_tx: string;
  };

  // S-PAL Compliance
  spal_compliance: {
    version: string;
    attestation_hash: string;
    auditor_did: string;
    last_audit: Date;
  };

  // Status
  status: 'pending' | 'active' | 'suspended' | 'revoked';
  status_reason?: string;

  // Metadata
  metadata_uri: string;  // IPFS URI

  // Timestamps
  registered: Date;
  last_updated: Date;
}

interface ProofType {
  category: string;        // e.g., "identity", "age", "credentials"
  specific_type: string;   // e.g., "over_18", "degree_verified"
  zkp_supported: boolean;
  spal_template_id?: string;
}

interface Jurisdiction {
  country_code: string;    // ISO 3166-1 alpha-2
  region?: string;
  regulatory_framework?: string;  // e.g., "GDPR", "CCPA", "eIDAS"
}
```

### Off-Chain Discovery API
```typescript
class TrustRegistryAPI {
  private cardanoClient: CardanoClient;
  private cache: ProverCache;

  constructor(config: RegistryConfig) {
    this.cardanoClient = new CardanoClient(config.networkId);
    this.cache = new ProverCache(config.cacheTTL);
  }

  /**
   * Query provers by criteria
   */
  async queryProvers(query: ProverQuery): Promise<ProverEntry[]> {
    // Check cache first
    const cacheKey = this.computeCacheKey(query);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Query on-chain registry
    const entries = await this.cardanoClient.queryRegistry({
      proof_type: query.proofType,
      jurisdiction: query.jurisdiction,
      spal_compliant: query.spalCompliant ?? true,
      status: 'active'
    });

    // Enrich with off-chain metadata
    const enriched = await Promise.all(
      entries.map(e => this.enrichWithMetadata(e))
    );

    // Cache and return
    this.cache.set(cacheKey, enriched);
    return enriched;
  }

  /**
   * Verify a prover's current status and compliance
   */
  async verifyProver(
    proverDid: string,
    proofType: string,
    policyHash?: string
  ): Promise<VerificationResult> {
    const entry = await this.cardanoClient.getProverEntry(proverDid);

    if (!entry) {
      return { valid: false, reason: 'Prover not found' };
    }

    if (entry.status !== 'active') {
      return { valid: false, reason: `Prover status: ${entry.status}` };
    }

    const supportsType = entry.proof_types.some(
      pt => pt.category === proofType || pt.specific_type === proofType
    );

    if (!supportsType) {
      return { valid: false, reason: 'Prover does not support requested proof type' };
    }

    // Verify S-PAL compliance if policy provided
    if (policyHash) {
      const compliant = await this.verifySPALCompliance(
        entry.spal_compliance,
        policyHash
      );
      if (!compliant) {
        return { valid: false, reason: 'Prover not compliant with specified S-PAL policy' };
      }
    }

    return {
      valid: true,
      entry: entry,
      trust_chain: await this.resolveTrustChain(entry.accrediting_authority)
    };
  }

  /**
   * AI-powered prover recommendation
   */
  async recommendProvers(
    requirements: BusinessRequirements
  ): Promise<ProverRecommendation[]> {
    // Get all matching provers
    const candidates = await this.queryProvers({
      proofType: requirements.proofType,
      jurisdiction: requirements.jurisdiction,
      spalCompliant: true
    });

    // Score and rank based on requirements
    const scored = candidates.map(prover => ({
      prover,
      score: this.computeScore(prover, requirements)
    }));

    // Sort by score and return top recommendations
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, requirements.maxResults ?? 5).map(s => ({
      prover: s.prover,
      score: s.score,
      reasons: this.explainScore(s.prover, requirements)
    }));
  }

  private computeScore(
    prover: ProverEntry,
    requirements: BusinessRequirements
  ): number {
    let score = 0;

    // S-PAL compliance version match
    if (prover.spal_compliance.version === requirements.spalVersion) {
      score += 30;
    }

    // ZKP support bonus
    if (prover.proof_types.some(pt => pt.zkp_supported)) {
      score += 20;
    }

    // Regulatory framework alignment
    const frameworks = requirements.regulatoryFrameworks ?? [];
    const matches = prover.jurisdictions.filter(
      j => j.regulatory_framework && frameworks.includes(j.regulatory_framework)
    );
    score += matches.length * 10;

    // Recent audit bonus
    const auditAge = Date.now() - prover.spal_compliance.last_audit.getTime();
    const monthsOld = auditAge / (1000 * 60 * 60 * 24 * 30);
    if (monthsOld < 3) score += 15;
    else if (monthsOld < 6) score += 10;
    else if (monthsOld < 12) score += 5;

    return score;
  }
}
```

### Trust Chain Resolution
```typescript
interface TrustChain {
  prover: ProverEntry;
  delegated_authority?: AuthorityEntry;
  root_authority: AuthorityEntry;
  pci_dao_recognition: DAORecognition;
}

class TrustChainResolver {
  async resolve(prover: ProverEntry): Promise<TrustChain> {
    const { accrediting_authority } = prover;

    let delegated: AuthorityEntry | undefined;
    let root: AuthorityEntry;

    if (accrediting_authority.type === 'delegated') {
      // Resolve delegated authority
      delegated = await this.getAuthority(accrediting_authority.did);

      // Follow chain to root
      root = await this.getAuthority(delegated.parent_authority_did);
    } else if (accrediting_authority.type === 'government') {
      root = await this.getAuthority(accrediting_authority.did);
    } else {
      // DAO-issued credential
      root = await this.getDAOAuthority();
    }

    // Verify Freehold DAO recognition
    const daoRecognition = await this.verifyDAORecognition(root.did);

    return {
      prover,
      delegated_authority: delegated,
      root_authority: root,
      pci_dao_recognition: daoRecognition
    };
  }
}
```

---

## S-PAL Specification

### S-PAL Document Structure (Version 1.0)

**Multi-Context Identity Support:** S-PAL recognizes that users have different identities across platforms and contexts. Your context in a work Slack differs from your context in a family WhatsApp. The `persona` field below is *proposed* (#135), not part of schema 1.0: it would scope a rule to one of the holder's identity contexts while keeping unified control. The agent refuses a policy that carries it until it is specified; the rest of the example loads as written.

```json
{
  "version": "1.0",
  "id": "spal:did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK:health-records",
  "name": "Health Records Access Policy",
  "created": "2025-01-01T00:00:00Z",
  "owner": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",

  "rules": [
    {
      "id": "rule-1",
      "context_scope": "medical/diagnosis_codes",
      "persona": {
        "type": "personal",
        "platforms": ["health.gov", "doctor-portal.com"],
        "description": "Personal health identity - not shared with employer"
      },
      "conditions": {
        "identity": {
          "type": "ephemeral_required",
          "linkage": "forbidden"
        },
        "proofs": [
          {
            "type": "zkp",
            "claim": "has_condition",
            "params": {
              "condition": "allergies",
              "result": false
            }
          }
        ],
        "retention": {
          "max_seconds": 0,
          "audit_log": true
        },
        "derivatives": {
          "training": "forbidden",
          "aggregation": "forbidden",
          "resale": "forbidden"
        },
        "payment": {
          "protocol": "x402",
          "amount": 1000,
          "currency": "sats"
        }
      }
    }
  ],

  "enforcement": {
    "smart_contract": "addr1_contract_...",
    "validators": ["cardano", "midnight"],
    "dispute_resolution": "dao:pci:health"
  },

  "signature": "..."
}
```

**Proposed for S-PAL 1.1 ([ADR-008](../decisions/008-positioning-nightframes-passport.md)):** a `processing` condition beside `retention`, `derivatives` and `payment`, stating where context under the rule may be processed — `locality` of `device_only`, `owned_hardware`, `community_node`, `federated_operator`, `attested_enclave` or `any` (least to most permissive), `hosted_models` of `forbidden` (default) or `allowed`, and `attestation_required`. A missing `processing` is read as `owned_hardware` with hosted models forbidden. Because it enters the signed preimage, it follows the injective encoding rules in [ADR-007](../decisions/007-cardano-midnight-interop-path.md).

**Locality semantics.** A `locality` value is a ceiling: it permits that level and
every stricter one (`community_node` is satisfied on the owner's device, on owned
hardware, or on a community node). Levels name the *kind* of operator:

| Level | Satisfied by |
|---|---|
| `device_only` | the owner's device |
| `owned_hardware` | hardware the owner controls |
| `community_node` | a node run by someone the holder knows: a family or community node (ADR-004 Tier 1–2). The operator is accountable to the holder personally, not through governance. |
| `federated_operator` | a node run by an accountable professional operator under community governance (ADR-004 Tier 3): a membership organisation's cluster, a library's node. The level names the kind of operator, not the hardware: a Tier 3 box qualifies whether or not it has a TEE, and one with a verified TEE satisfies `attested_enclave` as well. Without an enclave it is this level, not `any`. |
| `attested_enclave` | a TEE (CPU and, where used, GPU confidential computing) whose attestation is verified per session, on hardware held by an accountable operator (Tier 3–4 datacenter). Attestation does not protect against the physical holder. |
| `any` | any operator, including unvetted volunteers or marketplaces |

Levels are not exclusive: a node is judged by the strictest level it satisfies,
so a federated operator's node with a verified TEE satisfies `federated_operator`
policies as well as `attested_enclave` ones. The split between `community_node`
and `federated_operator` (decided 2026-11-07) is about who answers to whom: a
holder who allows "a node I know" has not allowed a professional operator they
have never met, however well governed, and a holder who allows a federated
operator has allowed the community nodes beneath it.

**Multi-machine requests.** A request is satisfied only if *every* machine that sees
its plaintext or activations satisfies the locality, including split-inference peers
and TLS-terminating proxies. Splitting a model across machines does not hide the
prompt from any of them.

**Named operators (open question).** `community_node` and `federated_operator`
do not say *which* community or operator. Proposed: an optional `operators` list of DIDs; when present, only those
operators qualify. When absent, any operator of the permitted kind qualifies. As part
of the signed preimage the list is canonical (sorted, deduplicated, absent and empty
distinguished) and its DIDs resolve through the Trust Registry.
Cryptographic private compute (MPC, FHE) has no level: current systems are ~3–4
orders of magnitude slower than plaintext for 7–8B models, and MPC's guarantee
rests on non-collusion, not on which operator runs the machine.

### Persona Types

S-PAL supports multiple persona types to reflect the natural complexity of human identity across different contexts:

| Persona Type | Description | Example Use Cases |
|--------------|-------------|-------------------|
| `personal` | Private individual context | Health records, family photos, personal finances |
| `professional` | Work-related identity | LinkedIn, employer systems, professional credentials |
| `public` | Intentionally public persona | Social media, blog, public portfolio |
| `anonymous` | Unlinkable interactions | Whistleblowing, sensitive research, activism |
| `pseudonymous` | Consistent but not linked to real identity | Gaming, online communities |
| `family` | Shared family context | Family calendar, shared photos, household accounts |
| `community` | Local/affinity group context | Neighborhood apps, club memberships |

**Key Design Principle:** Users maintain unified control over all personas from a single interface, but can set different policies for each. A policy for your `professional` persona might allow LinkedIn to verify employment, while your `personal` persona blocks all such requests.

### S-PAL Negotiation Protocol
```typescript
class SPALNegotiator {
  async negotiate(
    serviceRequest: ServiceRequest,
    userPolicy: SPALPolicy
  ): Promise<NegotiationResult> {

    // Step 1: Service presents requirements
    const requirements = serviceRequest.getRequirements();

    // Step 2: Check compatibility
    const conflicts = this.findConflicts(requirements, userPolicy);

    if (conflicts.length === 0) {
      // Full compatibility
      return {
        status: 'accepted',
        policy: userPolicy,
        proofs: await this.generateProofs(requirements)
      };
    }

    // Step 3: Attempt resolution
    const alternatives = this.suggestAlternatives(conflicts);

    if (alternatives.length > 0) {
      // Partial compatibility possible
      return {
        status: 'negotiable',
        alternatives: alternatives,
        conflicts: conflicts
      };
    }

    // Step 4: Rejection
    return {
      status: 'rejected',
      reason: 'Incompatible requirements',
      conflicts: conflicts
    };
  }
}
```

---

## Community Node Deployment

### Hardware Requirements

Sized as [ADR-004](../decisions/004-infrastructure-philosophy.md) sizes them: by silicon class, with memory bandwidth as the limit on inference (decode speed is about bandwidth divided by model size in bytes) and the services on whatever ordinary hardware is to hand. The 27B-class model tier is about 17 GB at Q4 before its KV cache, which is why nothing below 32 GB appears for inference. Splitting a model across boxes adds capacity, not speed, and the KV cache grows with context length times concurrent users, so scale for users with replicas and split only a model that does not fit one box. Memory encryption on the Strix Halo class (Memory Guard/TSME) needs a PRO SKU and BIOS support; verify before purchase.

```yaml
Services only (any tier; no local model on this box):
  cpu: 4 cores (ARM64 or x86_64); 6+ for a full Cardano relay under Leios
  ram: 16GB
  storage: 1TB NVMe SSD (more with chain nodes: see "Chain components" below)
  network: 100 Mbps symmetric
  runs: context store, agent, proof server, chain gateways; a relay or node is budgeted on top

Family node (a household):
  silicon: 32 GB unified-memory small desktop or laptop (Apple M-series, AMD Strix-class APU)
  model: one 27B Q4 model with room for its cache
  runs: everything above plus inference

Community node (a library, co-op or community centre):
  silicon: 128 GB-plus unified memory, AMD Strix Halo class, ~150 W at the wall
  bandwidth: ~215 GB/s measured (256 GB/s spec)
  model: 27B Q4 at ~12 tok/s (estimated by the rule), 70B Q4 at ~4.5-5 tok/s (measured, short context)
  cost: ~$2,500-3,500 (late 2026, moves with memory prices)
  runs: inference; the services on the same box or a cheap second one

Shared node (a community that outgrew one box):
  silicon: 2-3 community boxes, llama.cpp RPC over WireGuard, one operator
  runs: replicas first; one model split across boxes only within one operator
```

Chain components: a Cardano relay brings its own memory budget (16 GB with the UTxO set on disk under Leios), cores and disk, and a Midnight node with indexer its own memory and disk, so neither shares the 16 GB services box; a hosted gateway adds no local disk or memory, at the price of API limits and the operator seeing which addresses the community watches. Under Leios the ledger grows by hundreds of gigabytes a month at target throughput (CIP-0164's own estimate), so a relay's storage is planned per year, not bought once.

The reference stack in `infra/` ships with a small model so it starts on any box; the 27B tier is a GGUF file the operator puts in `MODELS_DIR` and names in `MODEL_FILE` (see `infra/README.md`). The installer below checks the hardware against that tier.

### One-Click Deployment Script
```bash
#!/bin/bash
set -e
# Freehold Community Node Installer

echo "🚀 Freehold Community Node Setup"

# Check system requirements
check_requirements() {
  RAM=$(free -m | awk '/^Mem:/{print $2}')
  CORES=$(nproc)

  # ADR-004's 32 GB names the silicon class; MemTotal on such a box reads below
  # 32768 MiB after firmware and iGPU reservations, so the check asks for what a
  # 27B Q4 model and its cache need rather than for the label.
  if [ $RAM -lt 16000 ]; then
    echo "⚠️  Warning: Less than 16GB total RAM detected; below the services-only floor"
  elif [ $RAM -lt 24000 ]; then
    echo "⚠️  Warning: Less than 24GB total RAM detected; a 27B Q4 model and its cache will not fit (services-only is fine at 16GB)"
  fi

  if [ $CORES -lt 4 ]; then
    echo "⚠️  Warning: Less than 4 CPU cores detected"
  fi
}

# Install dependencies (Docker Engine with the Compose plugin)
install_deps() {
  curl -fsSL https://get.docker.com | sh
}

# Deploy stack
deploy() {
  git clone https://github.com/freehold-earth/freehold
  cd freehold/infra

  # setup.sh creates .env from configs/example.env and pulls the base images
  ./scripts/setup.sh
  echo "Please edit .env with your community details"
  nano .env

  # Launch
  docker compose up -d

  echo "✅ Node deployed!"
  echo "🌐 Agent: https://localhost:8082"
  echo "📚 Docs: https://github.com/freehold-earth/freehold/tree/main/docs"
}

check_requirements
install_deps
deploy
```

### Monitoring Stack

Monitoring ports are for administrators only. They bind to loopback here; reach
them over SSH port forwarding, or over an admin VPN through a forwarding rule or
proxy on the host (a VPN address alone does not reach loopback), never by
publishing them.

```yaml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "127.0.0.1:9090:9090"

  grafana:
    image: grafana/grafana
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${ADMIN_PASSWORD}
    volumes:
      - grafana-storage:/var/lib/grafana

  node-exporter:
    image: prom/node-exporter
    ports:
      - "127.0.0.1:9100:9100"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
```

---

## Security Considerations

### Threat Model
```yaml
Threats:
  physical_access:
    risk: Medium
    mitigation:
      - Full disk encryption (LUKS)
      - Secure boot
      - TPM attestation
      - Multi-party key sharding

  network_attacks:
    risk: High
    mitigation:
      - TLS 1.3 minimum
      - Certificate pinning
      - TLS terminates on the node itself; no TLS-terminating CDN, tunnel or proxy
        (a third party that decrypts traffic sees every prompt — see inference_host)
      - DDoS: per-member auth and quotas at the gateway; any upstream DDoS service
        must pass TLS through without decrypting it
      - Rate limiting per DID
      - Only the gateway port (443) published; internal services unpublished or
        bound to 127.0.0.1 (Docker-published ports bypass host firewalls such as ufw)
      - TLS on every link, loopback or not: the agent refuses a plain-HTTP
        address for the model server, the context store, the ZKP service and
        the Cardano API, serves its own API over TLS or not at all, and the
        context store and ZKP service refuse to start without a certificate.
        The stack's own CA (infra/scripts/certs.sh) signs one per service and
        is the one thing a client trusts beyond the system store. A plain-HTTP
        third-party API (a Yaci devnet, Ollama) sits behind a TLS proxy on the
        same host; that hop, and the ZKP service's links to the Midnight
        services it runs beside (proof server, node, indexer, third-party
        images that serve plain HTTP on the compose network), are the
        plaintext left

  inference_host:
    description: >
      Any machine that computes on a request sees it in plaintext. Disk (LUKS),
      transport (TLS) and memory (TSME) encryption do not change this: the
      processor must read the data to compute on it.
    risk: High
    threats:
      plaintext_exposure: >
        The node operator, anyone with root, or an attacker who compromises the
        node can read prompts and outputs.
      split_inference_leak: >
        When a model is split across machines (pipeline/layer split), every
        machine receives hidden-state activations that can be inverted to
        recover the prompt (Qu et al., IEEE S&P 2025: a participant inverting
        its predecessor's activations recovers the prompt at 88.4% token
        accuracy on Llama-65B, Skytrax dataset; Dong et al., USENIX Security
        2025, "Depth Gives a False Sense of Privacy"). Noise and quantization
        do not prevent this without destroying output quality.
      tampering: >
        A machine in the path can alter activations or outputs. Correctness can
        only be checked by re-execution (redundancy or spot checks); spot checks
        deter repeated tampering but rarely catch a one-off targeted attack.
        Under a single accountable operator this is a governance matter; it is
        an open technical problem only for untrusted peers.
      retention: >
        Logs, prompt caches, debug endpoints and saved slots retain content
        after the request ends. This is retention on the node; retention by a
        verifying business is covered under Data Retention Enforcement.
    rules:
      - >
        Least-trusted-machine rule: a request's effective locality is that of the
        least trusted machine that sees its plaintext or activations, including
        proxies that terminate TLS. A split across a community node and a
        volunteer machine is `any`, not `community_node`.
      - >
        Split a model only across machines under the same accountable operator,
        linked by an authenticated private network (e.g. WireGuard); inference
        RPC ports (llama.cpp RPC, Ray) are never reachable outside it.
      - >
        `attested_enclave` removes host software from the trust boundary, not
        the physical holder: 2025 memory-bus interposer attacks (WireTap and
        Battering RAM on DDR4, TEE.fail on DDR5) extracted keys from SGX and
        SEV-SNP and forged TDX attestation, and vendors treat physical attacks
        as out of scope. It is honored only on attested hardware held by an
        accountable operator, not on any machine presenting a valid quote.
    mitigation:
      - Gateway enforces each request's S-PAL `processing` condition before routing
        (planned with the inference gateway, #90; until it exists, the operator
        chooses an inference host that satisfies the strictest policy its members hold)
      - Prefer stateless inference nodes (no per-user data at rest)
      - Inference server runs with slot persistence, prompt logging, verbose
        logging, web UI and built-in agent tools disabled (see the Community
        Node compose example for the llama-server flags)
      - No content or prompt-hash logs; usage metadata (member, time, tokens) kept
        for a governance-set period published to members
      - Named administrators with short-lived SSH certificates and an access log

  resource_abuse:
    risk: High
    description: >
      Exposed inference endpoints are found by scanners and used as free compute.
      DIDs are free to mint, so per-DID limits only hold if each DID is bound to
      something scarce (membership, library card).
    mitigation:
      - Membership credential required alongside the DID
      - Per-member token quotas (not request counts) at the gateway

  social_engineering:
    risk: High
    mitigation:
      - Multi-factor authentication
      - Social recovery (Shamir's Secret Sharing)
      - Time-locked operations
      - Community verification for high-value transactions

  consensus_attacks:
    risk: Low
    mitigation:
      - Multiple blockchain validators
      - Proof caching to reduce on-chain ops
      - Local-first architecture (blockchain failure doesn't break system)
```

### Cryptographic Standards
```yaml
Encryption:
  at_rest: AES-256-GCM
  in_transit: TLS 1.3 with PFS
  key_derivation: Argon2id
  signatures: Ed25519

Zero-Knowledge:
  proving_system: Groth16
  curves: BLS12-381
  trusted_setup: Powers of Tau ceremony

Blockchain:
  consensus: Ouroboros Praos (Cardano)
  finality: 30 confirmations
  rollback_protection: 2160 blocks
```

### Data Retention Enforcement

A critical challenge in S-PAL is enforcing "no retention" policies when data must be shared with businesses for verification. While ZK proofs prevent raw data disclosure, businesses may still receive derived information. Freehold employs multiple enforcement mechanisms:

#### 1. Cryptographic Time-Locks

Data is encrypted with time-locked keys that automatically expire:

```typescript
interface TimeLockEncryption {
  // Data is encrypted with a key that expires
  encryptWithExpiry(
    data: Buffer,
    expiresAt: Date,
    witnesses: string[]  // Threshold of witnesses required
  ): Promise<TimeLockCiphertext>;

  // Decryption fails after expiry
  decrypt(
    ciphertext: TimeLockCiphertext,
    currentTime: Date
  ): Promise<Buffer | null>;
}

class TimeLockService {
  async shareWithExpiry(
    data: Buffer,
    recipient: string,
    retentionSeconds: number
  ): Promise<TimeLockShare> {
    const expiresAt = new Date(Date.now() + retentionSeconds * 1000);

    // Use threshold encryption with time-release witnesses
    const ciphertext = await this.timelock.encryptWithExpiry(
      data,
      expiresAt,
      await this.getWitnessNetwork()
    );

    // Record on-chain for audit
    await this.recordShareEvent(recipient, expiresAt);

    return { ciphertext, expiresAt, recipient };
  }
}
```

#### 2. On-Chain Audit Trails

All data access events are recorded on Cardano for transparency and dispute resolution:

```rust
// Aiken: Audit trail contract
type AccessRecord {
  requester_did: ByteArray,
  data_hash: ByteArray,  // Hash of accessed data (not the data itself)
  policy_hash: ByteArray,
  retention_claim: Int,  // Seconds claimed
  timestamp: Int,
  signature: ByteArray,
}

validator audit_trail {
  fn record_access(record: AccessRecord, ctx: ScriptContext) -> Bool {
    // Verify requester signed the retention commitment
    verify_signature(record.requester_did, record.signature, ctx) &&
    // Record is within valid time window
    record.timestamp <= get_current_time(ctx) &&
    record.timestamp >= get_current_time(ctx) - 300  // 5 min tolerance
  }

  fn query_access_history(
    data_owner_did: ByteArray,
    ctx: ScriptContext
  ) -> List<AccessRecord> {
    // Returns all access records for dispute resolution
    get_records_by_owner(data_owner_did, ctx)
  }
}
```

#### 3. Threshold Decryption with Community Witnesses

Shared data requires M-of-N community witnesses for decryption, preventing unilateral retention:

```python
class ThresholdDecryption:
    def __init__(self, threshold: int, witnesses: List[str]):
        self.threshold = threshold
        self.witnesses = witnesses

    async def encrypt_for_sharing(
        self,
        data: bytes,
        retention_policy: RetentionPolicy
    ) -> ThresholdCiphertext:
        # Split key into shares
        key = os.urandom(32)
        shares = shamir_split(key, self.threshold, len(self.witnesses))

        # Encrypt data with key
        ciphertext = aes_gcm_encrypt(data, key)

        # Distribute shares to witnesses with expiry
        distributed = await self.distribute_shares(
            shares,
            retention_policy.expires_at
        )

        return ThresholdCiphertext(
            ciphertext=ciphertext,
            share_commitments=distributed,
            expires_at=retention_policy.expires_at
        )

    async def request_decryption(
        self,
        ciphertext: ThresholdCiphertext
    ) -> bytes | None:
        # Check if expired
        if datetime.now() > ciphertext.expires_at:
            # Witnesses will refuse to provide shares
            return None

        # Collect shares from witnesses
        shares = await self.collect_shares(
            ciphertext.share_commitments,
            self.threshold
        )

        # Reconstruct key and decrypt
        key = shamir_combine(shares)
        return aes_gcm_decrypt(ciphertext.ciphertext, key)
```

#### 4. Economic Incentives (Stake Collateral)

Businesses stake collateral that can be slashed for retention violations:

```rust
// Aiken: Collateral staking contract
type BusinessStake {
  business_did: ByteArray,
  collateral_utxo: OutputReference,
  collateral_amount: Int,  // Lovelace staked
  spal_commitment: ByteArray,  // Hash of S-PAL policy
  registered_at: Int,
}

type RetentionViolationClaim {
  claimant_did: ByteArray,
  business_did: ByteArray,
  access_record_tx: ByteArray,  // Reference to audit trail
  evidence_hash: ByteArray,
  claimed_violation_time: Int,
}

validator collateral_manager {
  fn stake_collateral(
    stake: BusinessStake,
    ctx: ScriptContext
  ) -> Bool {
    // Minimum stake: 1000 ADA
    stake.collateral_amount >= 1_000_000_000 &&
    // Business signed commitment
    verify_business_signature(stake, ctx)
  }

  fn claim_violation(
    claim: RetentionViolationClaim,
    arbitration_result: ArbitrationResult,
    ctx: ScriptContext
  ) -> Bool {
    // Must have DAO arbitration approval
    arbitration_result.approved &&
    arbitration_result.arbiter_signatures >= 3 &&
    // Transfer portion of stake to claimant
    outputs_contain_payment(
      ctx,
      claim.claimant_did,
      arbitration_result.award_amount
    )
  }

  fn withdraw_stake(
    business_did: ByteArray,
    ctx: ScriptContext
  ) -> Bool {
    // Can only withdraw if no pending claims
    // and minimum lock period (90 days) elapsed
    no_pending_claims(business_did, ctx) &&
    lock_period_elapsed(business_did, ctx)
  }
}
```

#### 5. Retention Enforcement Flow

```mermaid
sequenceDiagram
    participant U as User
    participant B as Business
    participant W as Witness Network
    participant C as Cardano
    participant A as Arbitration DAO

    U->>C: Check business stake (>1000 ADA)
    C-->>U: Stake verified

    U->>W: Create time-locked share
    W-->>U: Share commitment

    U->>B: Send encrypted data + share refs
    U->>C: Record access (audit trail)

    Note over B: Retention period expires

    B->>W: Request decryption
    W-->>B: Refused (expired)

    alt Violation Detected
        U->>A: Submit violation claim + evidence
        A->>A: Review evidence
        A->>C: Submit arbitration result
        C->>U: Transfer portion of stake
    end
```

#### 6. Graduated Trust Levels

Businesses earn trust through compliance history:

```typescript
interface TrustLevel {
  level: 'new' | 'established' | 'trusted' | 'verified';

  // Requirements by level
  requirements: {
    new: {
      min_stake: 1000,        // ADA
      max_retention: 0,       // No retention
      witness_threshold: 5,   // High threshold
    },
    established: {
      min_stake: 500,
      max_retention: 3600,    // 1 hour
      witness_threshold: 3,
    },
    trusted: {
      min_stake: 100,
      max_retention: 86400,   // 24 hours
      witness_threshold: 2,
    },
    verified: {
      min_stake: 50,
      max_retention: 604800,  // 7 days (with audit)
      witness_threshold: 1,
    },
  };

  // Level is determined by on-chain history
  computeLevel(history: ComplianceHistory): TrustLevel;
}
```

### Audit Logging
```python
class AuditLogger:
    def __init__(self, community_id: str):
        self.community_id = community_id
        self.log_store = TamperProofLog()

    def log_access(self, event: AccessEvent):
        entry = {
            'timestamp': time.time(),
            'did': event.ephemeral_did,
            'action': event.action,
            'resource': hash(event.resource),
            'policy': event.policy_hash,
            'result': event.result,
            'proof': event.generate_proof()
        }

        # Sign entry
        signature = self.sign(entry)

        # Store with merkle proof
        self.log_store.append(entry, signature)

        # Periodic checkpoint to blockchain
        if self.should_checkpoint():
            self.checkpoint_to_chain()
```

---

## API Specifications

### Agent API (REST)
```yaml
openapi: 3.0.0
info:
  title: Freehold Personal Agent API
  version: 1.0.0

paths:
  /agent/query:
    post:
      summary: Query personal agent with context
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                query:
                  type: string
                policy_id:
                  type: string
                proof_requirements:
                  type: array
                  items:
                    $ref: '#/components/schemas/ProofRequirement'
      responses:
        200:
          description: Successful response with proofs
          content:
            application/json:
              schema:
                type: object
                properties:
                  response:
                    type: string
                  proofs:
                    type: array
                    items:
                      $ref: '#/components/schemas/Proof'
                  ephemeral_did:
                    type: string
```

### S-PAL Negotiation API (WebSocket)
```typescript
interface SPALWebSocket {
  // Client -> Server
  onConnect(auth: {
    did: string;
    signature: string;
    timestamp: number;
  }): void;

  onPolicyProposal(policy: SPALPolicy): void;

  onProofSubmission(proofs: Proof[]): void;

  // Server -> Client
  onRequirementsRequest(requirements: ServiceRequirements): void;

  onNegotiationResult(result: {
    status: 'accepted' | 'rejected' | 'negotiable';
    conflicts?: Conflict[];
    alternatives?: SPALPolicy[];
  }): void;

  onSessionEstablished(session: {
    id: string;
    validUntil: Date;
    capabilities: string[];
  }): void;
}
```

### Community Federation Protocol
```protobuf
syntax = "proto3";

service CommunityFederation {
  rpc RegisterPeer(PeerRegistration) returns (PeerCredentials);
  rpc ShareProof(ProofShareRequest) returns (ProofShareResponse);
  rpc RequestBackup(BackupRequest) returns (BackupResponse);
  rpc VerifyNode(NodeVerification) returns (AttestationResult);
}

message PeerRegistration {
  string community_id = 1;
  string did = 2;
  bytes public_key = 3;
  repeated string capabilities = 4;
  string endpoint = 5;
}

message ProofShareRequest {
  string proof_hash = 1;
  string requester_did = 2;
  bytes signature = 3;
  int64 ttl = 4;
}
```

---

## Implementation Timeline

### Phase 1: MVP (Months 1-3)
- [ ] Browser extension with basic DID management
- [ ] Local context store (Yjs integration)
- [ ] Simple S-PAL templates
- [ ] Basic proof generation (age, location)

### Phase 2: Community Nodes (Months 4-6)
- [ ] Docker deployment package
- [ ] Community node management dashboard
- [ ] Agent orchestration
- [ ] Federation protocol v1

### Phase 3: Scale (Months 7-12)
- [ ] Cardano smart contract deployment
- [ ] Midnight integration
- [ ] Proof markets
- [ ] 100+ node network

### Phase 4: Production (Months 13-18)
- [ ] Security audits
- [ ] Performance optimization
- [ ] Enterprise integration
- [ ] Regulatory compliance tools

---

## Resources

### Documentation
- Website: https://freehold.earth
- Documentation: https://github.com/freehold-earth/freehold/tree/main/docs
- S-PAL Schema: https://github.com/freehold-earth/freehold/blob/main/spec/schemas/spal/v1.0/schema.json
- Agent API Reference: https://github.com/freehold-earth/freehold/blob/main/spec/api/openapi/agent-api.yaml

### Code
- Monorepo (agent, context store, contracts, ZKP, identity, infrastructure): https://github.com/freehold-earth/freehold

### Community and Help
- Discussion and support: https://github.com/freehold-earth/freehold/discussions
- Bugs: https://github.com/freehold-earth/freehold/issues

---

*This is a living document. Latest version at https://github.com/freehold-earth/freehold/blob/main/docs/architecture/technical-appendix.md*
