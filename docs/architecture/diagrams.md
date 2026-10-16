# PCI Architecture Diagrams

## 5-Layer Sovereign Stack (with Trust Registry)

```mermaid
graph TB
    subgraph "Layer 5: Trust Registry"
        REG[On-Chain Registry]
        DISC[Discovery Platform]
        API[Prover API]
        REG --> DISC
        REG --> API
    end
    
    subgraph "Layer 4: Trust Bridge"
        ZKP[Zero-Knowledge Proofs]
        EDID[Ephemeral DIDs]
        PROOF[Proof Generation]
        ZKP --> PROOF
        EDID --> PROOF
    end
    
    subgraph "Layer 3: Sovereignty Layer"
        SC[Smart Contracts]
        SPAL[S-PAL Enforcement]
        DID[Identity Management]
        SC --> SPAL
        DID --> SPAL
    end
    
    subgraph "Layer 2: Personal Agent"
        AI[Local AI Models]
        AGENT[Context Processing]
        DECIDE[Decision Engine]
        AI --> AGENT
        AGENT --> DECIDE
    end
    
    subgraph "Layer 1: Context Store"
        VAULT[Encrypted Vaults]
        SYNC[Sync Engine]
        EMB[Vector Embeddings]
        VAULT --> SYNC
        EMB --> SYNC
    end
    
    EXT[External Service] -.->|Request| PROOF
    PROOF -.->|Query Prover| API
    API -.->|Verified Prover| PROOF
    PROOF -.->|Verified Claim| EXT
    USER[You/Community] ==>|Full Control| VAULT
    
    VAULT --> AGENT
    AGENT --> SPAL
    SPAL --> PROOF
    REG --> SC
    
    style Layer1 fill:#2E7D32,color:#fff
    style Layer2 fill:#1976D2,color:#fff
    style Layer3 fill:#7B1FA2,color:#fff
    style Layer4 fill:#F57C00,color:#fff
    style Layer5 fill:#C62828,color:#fff
```

## Data Flow Sequence

```mermaid
sequenceDiagram
    participant User
    participant Context Store
    participant Agent
    participant Sovereignty
    participant Trust Bridge
    participant Trust Registry
    participant Service
    
    Service->>Trust Bridge: Request data
    Trust Bridge->>Trust Registry: Query valid provers
    Trust Registry-->>Trust Bridge: Prover list + S-PAL status
    Trust Bridge->>Sovereignty: Check S-PAL policy
    Sovereignty->>Agent: Policy allows?
    Agent->>Context Store: Retrieve context
    Context Store-->>Agent: Encrypted data
    Agent-->>Sovereignty: Generate proof
    Sovereignty-->>Trust Bridge: Proof + Ephemeral DID
    Trust Bridge-->>Service: ZK Proof (no raw data)
    Service-->>User: Service provided
```

## Trust Registry Architecture

```mermaid
graph TB
    subgraph "Interface Layer (Off-Chain)"
        BP[Business Portal]
        AI[AI Discovery Engine]
        DAPI[Developer API]
    end
    
    subgraph "On-Chain Registry (Cardano)"
        REG[(Registry Entries)]
        SC[Registry Smart Contract]
        ATT[Attestations]
    end
    
    subgraph "Authority Chain"
        GOV[Government Authorities]
        DEL[Delegated Authorities]
        DAO[PCI DAO]
    end
    
    subgraph "Provers"
        P1[Age Verification Provider]
        P2[Identity Provider]
        P3[Credential Verifier]
    end
    
    BP --> DAPI
    AI --> DAPI
    DAPI --> SC
    SC --> REG
    
    GOV --> ATT
    DEL --> ATT
    DAO --> ATT
    ATT --> REG
    
    P1 --> SC
    P2 --> SC
    P3 --> SC
    
    style BP fill:#E3F2FD
    style AI fill:#E3F2FD
    style DAPI fill:#E3F2FD
    style REG fill:#7B1FA2,color:#fff
    style SC fill:#7B1FA2,color:#fff
```

## Prover Registration Flow

```mermaid
sequenceDiagram
    participant Prover
    participant Registry Contract
    participant Accrediting Authority
    participant S-PAL Auditor
    participant PCI DAO
    
    Prover->>Registry Contract: Submit registration
    Registry Contract->>Accrediting Authority: Request attestation
    Accrediting Authority-->>Registry Contract: Issue attestation
    
    Prover->>S-PAL Auditor: Request compliance audit
    S-PAL Auditor->>Prover: Perform audit
    S-PAL Auditor-->>Registry Contract: Submit compliance proof
    
    Registry Contract->>PCI DAO: Verify attestation chain
    PCI DAO-->>Registry Contract: Approval
    Registry Contract-->>Prover: Registration complete
    
    Note over Registry Contract: Entry now queryable<br/>by businesses & wallets
```

## Community Cloud Architecture

```mermaid
graph LR
    subgraph "Individual Level"
        DEV1[Personal Devices]
        DEV2[Family Node]
    end
    
    subgraph "Community Level"
        LIB[Library Node]
        COOP[Co-op Node]
        TECH[Local Tech Business]
        LIB -.->|Federate| COOP
        COOP -.->|Federate| TECH
    end
    
    subgraph "Regional Level"
        MUNI[Municipal Infrastructure]
        UNI[University Nodes]
        MUNI -.->|Backup| UNI
    end
    
    DEV1 --> LIB
    DEV1 --> COOP
    DEV2 --> TECH
    LIB --> MUNI
    COOP --> MUNI
    TECH --> UNI
    
    style DEV1 fill:#E8F5E9
    style LIB fill:#81C784
    style MUNI fill:#2E7D32
```

## Deployment Options

```mermaid
graph TD
    A[User Needs PCI] --> B{Technical Skill?}
    
    B -->|High| C[Run Own Node]
    B -->|Medium| D[Family/Friend Node]
    B -->|Low| E[Community Node]
    
    C --> F[Full Sovereignty]
    D --> G[Shared Trust]
    E --> H[Managed Service]
    
    F --> I[Maximum Control]
    G --> J[Balance of Control/Ease]
    H --> K[Maximum Ease]
    
    style A fill:#fff,stroke:#333
    style I fill:#4CAF50
    style J fill:#2196F3
    style K fill:#FF9800
```

## Security Model

```mermaid
graph TB
    subgraph "Threats"
        T1[Physical Access]
        T2[Network Attack]
        T3[Social Engineering]
        T4[Consensus Attack]
    end
    
    subgraph "Mitigations"
        M1[Encryption at Rest]
        M2[TLS + Rate Limiting]
        M3[Social Recovery]
        M4[Local-First Architecture]
    end
    
    T1 --> M1
    T2 --> M2
    T3 --> M3
    T4 --> M4
    
    M1 --> SECURE[Secure System]
    M2 --> SECURE
    M3 --> SECURE
    M4 --> SECURE
    
    style T1 fill:#ffcccc
    style T2 fill:#ffcccc
    style T3 fill:#ffcccc
    style T4 fill:#ffcccc
    style SECURE fill:#ccffcc
```

## Implementation Phases

```mermaid
gantt
    title PCI Implementation Roadmap
    dateFormat  YYYY-MM-DD
    section Phase 1 - Foundation
    Browser Extension        :2025-01-01, 90d
    Basic S-PAL Templates   :2025-01-15, 75d
    Context Store (Yjs)     :2025-02-01, 60d
    
    section Phase 2 - Community
    Docker Package          :2025-04-01, 60d
    First 5 Pilot Nodes    :2025-04-15, 90d
    Agent Integration      :2025-05-01, 75d
    
    section Phase 3 - Scale
    Smart Contracts        :2025-07-01, 90d
    ZKP Integration        :2025-07-15, 90d
    Federation Protocol    :2025-08-01, 60d
    
    section Phase 4 - Trust Registry
    On-Chain Registry      :2025-07-01, 90d
    Business Portal        :2025-08-01, 75d
    AI Discovery           :2025-09-01, 90d
    Prover Onboarding      :2025-10-01, 60d
    
    section Phase 5 - Production
    Security Audits        :2025-10-01, 60d
    100+ Nodes            :2025-11-01, 90d
    Enterprise Features    :2025-12-01, 90d
```
