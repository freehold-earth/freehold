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

/**
 * Payment currency for S-PAL policies.
 *
 * - `{ kind: "Ada" }` — Constr(0, []) on-chain. Payment in lovelace (1 ADA = 1,000,000 lovelace).
 * - `{ kind: "NativeToken", policyId, assetName }` — Constr(1, [policy_id, asset_name]) on-chain.
 *   Payment in a native token (e.g., USDCx uses 6 decimal places: 1 USDCx = 1,000,000 micro-USDCx).
 *
 * `policyId` must be a 56-character hex string (28-byte Cardano policy hash).
 * `assetName` must be a hex-encoded byte string, 0–64 hex characters (0–32 bytes).
 * Use {@link validatePaymentCurrency} to validate at construction boundaries.
 *
 * Note: Every Cardano UTxO must carry minimum ADA (~1.2-2 ADA) even for pure token transfers.
 * One currency per policy; "accept either" is not supported in MVP.
 */
export type PaymentCurrency =
  | { readonly kind: "Ada" }
  | { readonly kind: "NativeToken"; readonly policyId: string; readonly assetName: string };

/** Type guard: returns true if currency is Ada */
export function isAda(c: PaymentCurrency): c is { readonly kind: "Ada" } {
  return c.kind === "Ada";
}

/** Type guard: returns true if currency is NativeToken */
export function isNativeToken(
  c: PaymentCurrency
): c is { readonly kind: "NativeToken"; readonly policyId: string; readonly assetName: string } {
  return c.kind === "NativeToken";
}

/** Exhaustiveness helper — use in default/else branches of PaymentCurrency switches */
export function assertNeverCurrency(c: never): never {
  throw new Error(`Unexpected PaymentCurrency: ${JSON.stringify(c)}`);
}

/**
 * Validate a PaymentCurrency value at construction boundaries.
 *
 * For NativeToken:
 * - policyId must be exactly 56 hex characters (non-empty — empty policyId is ADA on-chain)
 * - assetName must be 0–64 hex characters (even length)
 *
 * @throws Error if validation fails
 */
export function validatePaymentCurrency(c: PaymentCurrency): void {
  if (c.kind === "Ada") return;

  const HEX_RE = /^[0-9a-fA-F]*$/;

  const pid = typeof c.policyId === "string" ? c.policyId : String(c.policyId ?? "");
  const pidLen = typeof c.policyId === "string" ? c.policyId.length : 0;
  if (typeof c.policyId !== "string" || pidLen !== 56 || !HEX_RE.test(pid)) {
    throw new Error(
      `Invalid policyId: must be exactly 56 hex characters, got "${pid}" (${pidLen} chars)`
    );
  }

  const an = typeof c.assetName === "string" ? c.assetName : String(c.assetName ?? "");
  const anLen = typeof c.assetName === "string" ? c.assetName.length : 0;
  if (
    typeof c.assetName !== "string" ||
    anLen > 64 ||
    anLen % 2 !== 0 ||
    !HEX_RE.test(an)
  ) {
    throw new Error(
      `Invalid assetName: must be 0–64 even-length hex characters, got "${an}" (${anLen} chars)`
    );
  }
}

export interface SPALPolicy {
  /** Policy identifier */
  id: string;
  /** Policy owner's public key hash */
  ownerPkh: string;
  /** Minimum payment amount (0 = no payment required). Units depend on paymentCurrency. */
  minPayment: bigint;
  /** Maximum data retention in milliseconds */
  maxRetentionMs: number;
  /** Identity linkage rules */
  identityLinkage: IdentityLinkage;
  /** Hash of required ZKP proof type (empty string = no proof required) */
  requiredProofHash: string;
  /** Data context scope path (e.g., "medical/diagnosis_codes") */
  contextScope: string;
  /**
   * Payment currency (Ada or native token).
   * Always required — mirrors the on-chain PolicyDatum which has 7 fields.
   */
  paymentCurrency: PaymentCurrency;
}

export interface ValidationRequest {
  /** The S-PAL policy ID (optional, for reference) */
  policyId?: string;
  /** Requester's DID (ephemeral did:key or persistent) */
  requesterDid: string;
  /** Reference to ZKP proof (e.g., Midnight tx hash) */
  proofReference: string;
  /** Access timestamp for audit */
  accessTime: number;
  /** Payment amount (must meet minPayment). Units match policy's paymentCurrency. */
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
