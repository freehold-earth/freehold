/**
 * PCI Identity - W3C DID implementation for PCI
 *
 * Privacy Model:
 * - Third parties CANNOT link ephemeral DIDs to each other or to root
 * - User CAN prove any ephemeral DID belongs to their root (for legal/audit)
 * - Authorization records provide the cryptographic proof of linkage
 *
 * See: pci-docs/PCI_Identity_Privacy_Model.md for full specification
 *
 * @packageDocumentation
 */

export {
  // Core Types
  type DIDKeyPair,
  type SerializedDIDKeyPair,
  // Authorization Types
  type AuthorizationContext,
  type AuthorizationRecord,
  type SerializedAuthorizationRecord,
  type AuthorizedEphemeralDID,
  // Core DID functions
  generateDID,
  generateEphemeralDID,
  publicKeyToDID,
  didToPublicKey,
  // Authorization functions (preferred for ephemeral DIDs)
  generateAuthorizedEphemeralDID,
  verifyAuthorizationRecord,
  isAuthorizationExpired,
  // Signing/verification
  signWithDID,
  verifyDIDSignature,
  // Validation
  isValidDIDKey,
  // Serialization - DID
  serializeDIDKeyPair,
  deserializeDIDKeyPair,
  // Serialization - Authorization
  serializeAuthorizationRecord,
  deserializeAuthorizationRecord,
  // Display
  truncateDID,
} from "./did.js";

// Midnight Shielded Funding Types (for future implementation)
export {
  type CardanoAddress,
  type ShieldedBalance,
  type ShieldedWitness,
  type EphemeralWallet,
  type FundingLinkProof,
  type FundingDisclosure,
  type ShieldedFundingService,
  type ShieldedFundingConfig,
} from "./funding.js";
