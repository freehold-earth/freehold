/**
 * Type definitions for PCI Contracts
 */

/**
 * Identity linkage rules for privacy-preserving verification
 * Controls how ephemeral DIDs relate to root identity
 */
export interface IdentityLinkage {
  /** Requester must use ephemeral DID (did:key) - unlinkable by third parties */
  ephemeralRequired: boolean;
  /** Requester may voluntarily prove root DID ownership (for legal/audit) */
  proofOfRootAllowed: boolean;
  /** Requester may prove same-person across sessions via ZK (without revealing identity) */
  zkContinuityAllowed: boolean;
}

export interface SPALPolicy {
  /** Policy identifier */
  id: string;
  /** Policy owner's public key hash */
  ownerPkh: string;
  /** Minimum payment in lovelace (0 = no payment required) */
  minPayment: bigint;
  /** Maximum data retention in milliseconds */
  maxRetentionMs: number;
  /** Identity linkage rules */
  identityLinkage: IdentityLinkage;
  /** Hash of required ZKP proof type (empty string = no proof required) */
  requiredProofHash: string;
  /** Data context scope path (e.g., "medical/diagnosis_codes") */
  contextScope: string;
}

export interface ValidationRequest {
  /** The S-PAL policy ID */
  policyId: string;
  /** Requester's DID (ephemeral did:key or persistent) */
  requesterDid: string;
  /** Reference to ZKP proof (e.g., Midnight tx hash) */
  proofReference: string;
  /** Access timestamp for audit */
  accessTime: number;
  /** Payment amount in lovelace (must meet minPayment) */
  paymentAmount: bigint;
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

/**
 * Cardano network configuration
 */
export type Network = "Mainnet" | "Preprod" | "Preview" | "Custom";

/**
 * Lucid provider configuration
 */
export interface LucidConfig {
  /** Network to connect to */
  network: Network;
  /** Provider URL (Kupmios for Yaci devnet, Blockfrost for testnets/mainnet) */
  providerUrl: string;
  /** API key (for Blockfrost) */
  apiKey?: string;
  /** Custom network magic (for custom networks) */
  networkMagic?: number;
}

/**
 * Policy UTxO information
 */
export interface PolicyUtxo {
  /** Transaction hash of the UTxO */
  txHash: string;
  /** Output index */
  outputIndex: number;
  /** The policy datum */
  datum: SPALPolicy;
  /** Lovelace value locked */
  lovelace: bigint;
}
