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
