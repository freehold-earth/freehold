/**
 * Type definitions for PCI Contracts
 */

export interface SPALPolicy {
  /** Policy identifier */
  id: string;
  /** Policy owner's public key hash */
  ownerPkh: string;
  /** Maximum data retention in seconds */
  maxRetention: number;
  /** Whether derivatives are forbidden */
  derivativesForbidden: boolean;
  /** Required payment in lovelace */
  requiredPayment: bigint;
}

export interface ValidationRequest {
  /** The S-PAL policy ID */
  policyId: string;
  /** Requester's DID */
  requesterDid: string;
  /** Context scope being accessed */
  contextScope: string;
  /** Zero-knowledge proofs */
  proofs: ProofData[];
  /** Payment amount (if required) */
  paymentAmount?: bigint;
}

export interface ProofData {
  /** Proof type */
  type: "zkp" | "attestation" | "signature";
  /** The claim being proven */
  claim: string;
  /** Serialized proof */
  proof: string;
  /** Verification key */
  verificationKey: string;
}

export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Transaction hash if submitted */
  txHash?: string;
}

export interface CompiledScript {
  /** Compiled Plutus script (CBOR hex) */
  cborHex: string;
  /** Script hash */
  hash: string;
  /** Script address (for specific network) */
  address?: string;
}
