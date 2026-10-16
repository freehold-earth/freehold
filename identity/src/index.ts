/**
 * PCI Identity - W3C DID implementation for PCI
 *
 * Privacy Model:
 * - Third parties CANNOT link ephemeral DIDs to each other or to root
 * - User CAN prove any ephemeral DID belongs to their root (for legal/audit)
 * - Authorization records provide the cryptographic proof of linkage
 *
 * See: pci-docs/concepts/identity-privacy-model.md for full specification
 *
 * @packageDocumentation
 */

export {
  // Authorization Types
  type AuthorizationContext,
  type AuthorizationRecord,
  type AuthorizedEphemeralDID,
  // Core Types
  type DIDKeyPair,
  deserializeAuthorizationRecord,
  deserializeDIDKeyPair,
  didToPublicKey,
  // Authorization functions (preferred for ephemeral DIDs)
  generateAuthorizedEphemeralDID,
  // Core DID functions
  generateDID,
  generateEphemeralDID,
  isAuthorizationExpired,
  // Validation
  isValidDIDKey,
  publicKeyToDID,
  type SerializedAuthorizationRecord,
  type SerializedDIDKeyPair,
  // Serialization - Authorization
  serializeAuthorizationRecord,
  // Serialization - DID
  serializeDIDKeyPair,
  // Signing/verification
  signWithDID,
  // Display
  truncateDID,
  verifyAuthorizationRecord,
  verifyDIDSignature,
} from "./did.js"

// Midnight Shielded Funding Types (for future implementation)
export type {
  CardanoAddress,
  EphemeralWallet,
  FundingDisclosure,
  FundingLinkProof,
  ShieldedBalance,
  ShieldedFundingConfig,
  ShieldedFundingService,
  ShieldedWitness,
} from "./funding.js"
