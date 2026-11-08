/**
 * Shared types for Freehold Demo
 */

// S-PAL policy types live in ./policies (the spec's shape, spec/schemas/spal/v1.0).

// ============================================
// Verification Request Types (freehold-agent coordination API)
// ============================================

/**
 * Lifecycle states reported by the freehold-agent coordination API.
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
  /**
   * The ephemeral DID the proof is for: the circuit commits to it and the
   * public signals name it. Null when the proof is for none (an autonomous
   * approval, for one).
   */
  requester_did?: string | null;
  /**
   * The approval as this app signed it with the DID's key: the DID and a
   * base64 signature over the request id and the DID. The agent accepted
   * the DID only with it; a business verifies it against the request it
   * holds. Null when the approval named no DID.
   */
  attestation?: { requester_did: string; signature: string } | null;
  /** The terms hash the business sent, echoed, so both sides hold the same reference. */
  terms_hash?: string | null;
}

export interface VerificationRequest {
  id: string;
  business_id: string;
  business_name: string;
  /** What the business is requesting to verify */
  claim: VerificationClaim;
  /**
   * The hash of the policy terms the business accepted (spec/protocols/policy-terms.md).
   * Never a policy id: that would carry the root DID.
   */
  terms_hash: string;
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
  /** Pre-configured policies, in the spec's shape (see ./policies) */
  policies: import("./policies").SPALPolicy[];
  /** Sample verification requests */
  sampleRequests: Omit<VerificationRequest, "id" | "created_at" | "expires_at">[];
}
