/**
 * Shared types for PCI Demo
 */

// ============================================
// S-PAL Policy Types (Phase 1)
// ============================================

/**
 * Identity linkage rules for privacy-preserving verification.
 * Controls how ephemeral DIDs relate to root identity.
 */
export interface IdentityLinkage {
  /** Requester must use ephemeral DID (did:key) - unlinkable by third parties */
  ephemeralRequired: boolean;
  /** Requester may voluntarily prove root DID ownership (for legal/audit) */
  proofOfRootAllowed: boolean;
  /** Requester may prove same-person across sessions via ZK (without revealing identity) */
  zkContinuityAllowed: boolean;
}

/**
 * Controls on derivative use of data
 */
export interface DerivativePolicy {
  /** AI/ML training usage */
  training: "forbidden" | "allowed" | "requires_payment";
  /** Statistical aggregation */
  aggregation: "forbidden" | "allowed" | "anonymized_only";
  /** Resale to third parties */
  resale: "forbidden" | "allowed" | "requires_consent";
}

/**
 * S-PAL Policy - Sovereign Privacy & Access Language
 * Phase 1 schema with identity linkage and structured controls
 */
export interface SPALPolicy {
  /** Policy identifier (format: spal:did:pci:...) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Policy description */
  description: string;
  /** Policy owner's DID */
  ownerDid: string;
  /** Data context scope path (e.g., "personal/age", "medical/diagnosis_codes") */
  contextScope: string;
  /** Identity linkage rules */
  identityLinkage: IdentityLinkage;
  /** Minimum payment in lovelace (0 = no payment required) */
  minPayment: number;
  /** Maximum data retention in milliseconds (0 = no retention) */
  maxRetentionMs: number;
  /** Allowed operations on the data */
  allowedOperations: ("verify" | "read" | "aggregate")[];
  /** Derivative use controls */
  derivatives: DerivativePolicy;
  /** When this policy was created (ISO 8601) */
  createdAt: string;
  /** When this policy was last updated (ISO 8601) */
  updatedAt: string;
}

// ============================================
// Verification Request Types
// ============================================

export interface VerificationRequest {
  id: string;
  type: "age" | "credential" | "custom";
  businessId: string;
  businessName: string;
  /** What the business is requesting to verify */
  claim: VerificationClaim;
  /** S-PAL policy ID this request must comply with */
  policyId?: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: Date;
  expiresAt: Date;
}

export type VerificationClaim =
  | AgeVerificationClaim
  | CredentialVerificationClaim;

export interface AgeVerificationClaim {
  type: "age";
  /** Minimum age to verify */
  minAge: number;
}

export interface CredentialVerificationClaim {
  type: "credential";
  /** Type of credential to verify */
  credentialType: string;
  /** Issuer public key (optional - any issuer if not specified) */
  issuerPublicKey?: string;
}

// ============================================
// Verification Response Types
// ============================================

export interface VerificationResponse {
  requestId: string;
  status: "verified" | "rejected" | "error";
  /** The ZK proof (if verified) */
  proof?: ZKProof;
  /** Public signals revealed by the proof */
  publicSignals?: Record<string, unknown>;
  /** Error message (if error) */
  error?: string;
}

export interface ZKProof {
  /** Base64 encoded proof data */
  proof: string;
  /** Circuit identifier */
  circuitId: string;
  /** Verification key identifier */
  verificationKey: string;
  /** When the proof was generated */
  timestamp: Date;
}

// ============================================
// Identity Types
// ============================================

export interface RootIdentity {
  /** The root DID (did:key:z...) - never shared externally */
  did: string;
  /** Serialized public key bytes */
  publicKey: number[];
  /** Serialized private key bytes - stored encrypted */
  privateKey: number[];
  /** When this identity was created */
  createdAt: string;
}

// ============================================
// Context Store Types
// ============================================

export interface ContextEntry {
  id: string;
  type: "personal" | "credential" | "preference";
  /** Encrypted data (only user can decrypt) */
  data: Record<string, unknown>;
  /** When this entry was created */
  createdAt: Date;
  /** When this entry was last updated */
  updatedAt: Date;
}

export interface PersonalContext {
  /** Date of birth (for age verification) */
  birthDate?: string;
  /** Full legal name */
  fullName?: string;
  /** Verified credentials */
  credentials?: CredentialContext[];
}

export interface CredentialContext {
  type: string;
  issuer: string;
  issuerPublicKey: string;
  issuedAt: Date;
  expiresAt?: Date;
  /** Signature from issuer */
  signature: string;
}

// ============================================
// API Types
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================
// Demo Scenario Types
// ============================================

export interface DemoScenario {
  id: string;
  name: string;
  description: string;
  /** Pre-configured user context */
  userContext: PersonalContext;
  /** Pre-configured policies */
  policies: SPALPolicy[];
  /** Sample verification requests */
  sampleRequests: Omit<VerificationRequest, "id" | "createdAt" | "expiresAt">[];
}
