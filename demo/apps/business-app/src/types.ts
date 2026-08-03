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
// Verification Request Types (pci-agent coordination API)
// ============================================

/**
 * Lifecycle states reported by the pci-agent coordination API.
 *
 * "pending" and "escalated" await a human decision (approve/deny are
 * accepted; the agent answers 409 once resolved). All other states are
 * terminal. A request past expires_at stays "pending" server-side and
 * resolves as "denied" when a decision is attempted.
 */
export type VerificationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "denied"
  | "escalated"
  | "error";

export interface VerificationClaim {
  /** Claim kind, e.g. "age" */
  type: string;
  /** Claim-specific parameters, e.g. { minAge: 21 } */
  params: Record<string, unknown>;
}

/** Resolution details attached to a request once it is no longer pending */
export interface VerificationResponse {
  reason: string;
  /** ZK proof payload (present when the claim was proven) */
  proof?: Record<string, unknown> | null;
}

export interface VerificationRequest {
  id: string;
  business_id: string;
  business_name: string;
  /** What the business is requesting to verify */
  claim: VerificationClaim;
  /** S-PAL policy ID this request must comply with */
  policy_id: string | null;
  /** Data context scope path (e.g., "personal/age") */
  context_scope: string | null;
  /** Service request this verification belongs to, if any */
  service_request_id: string | null;
  status: VerificationStatus;
  created_at: string;
  expires_at: string;
  response: VerificationResponse | null;
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
  sampleRequests: Omit<VerificationRequest, "id" | "created_at" | "expires_at">[];
}
