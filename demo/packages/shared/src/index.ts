/**
 * Shared types for PCI Demo
 */

// ============================================
// S-PAL Policy Types
// ============================================

export interface SPALPolicy {
  id: string;
  name: string;
  description: string;
  rules: PolicyRule[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyRule {
  /** What type of data access this rule covers */
  dataType: "age" | "credential" | "identity" | "custom";
  /** What operations are allowed */
  allowedOperations: ("verify" | "read" | "aggregate")[];
  /** Maximum retention period in seconds (0 = no retention) */
  maxRetention: number;
  /** Whether derivatives can be created from this data */
  allowDerivatives: boolean;
  /** Required payment in lovelace (0 = free) */
  requiredPayment: number;
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
