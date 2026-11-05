/**
 * Freehold Identity - W3C DID implementation for Freehold
 *
 * Privacy Model:
 * - Third parties CANNOT link ephemeral DIDs to each other or to root
 * - User CAN prove any ephemeral DID belongs to their root (for legal/audit)
 * - Authorization records provide the cryptographic proof of linkage
 *
 * See: docs/concepts/identity-privacy-model.md for full specification
 *
 * @packageDocumentation
 */

export {
  // Approval attestation: an ephemeral DID's holder approving one request
  type ApprovalAttestation,
  // Authorization Types
  type AuthorizationContext,
  type AuthorizationRecord,
  type AuthorizedEphemeralDID,
  attestApproval,
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
  type VerifyAuthorizationOptions,
  type VerifySignatureOptions,
  verifyApprovalAttestation,
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
// Canonical preimage encoding (spec/protocols/preimage-encoding.md)
export {
  type AuthorizationRecordData,
  approvalPreimage,
  authorizationPreimage,
  canonicalJson,
  DID_APPROVAL_DOMAIN_SEPARATOR,
  DID_AUTHORIZATION_DOMAIN_SEPARATOR,
  encodePreimage,
  MAX_VARIABLE_FIELD_LENGTH,
  type PreimageField,
} from "./preimage.js"
// External roots: atproto accounts (did:plc, did:web) bound to a Freehold key
export {
  type AtprotoSession,
  CLOCK_TOLERANCE_MS,
  createRootKeyResolver,
  DEFAULT_PLC_DIRECTORY,
  type DestinationOptions,
  type DIDDocument,
  type DIDResolver,
  didDocumentUrl,
  type FetchLike,
  httpDidResolver,
  isBindingValidAt,
  isExternalRootDid,
  type PublishedRootKey,
  parseDidDocument,
  parseRootKeyRecord,
  pdsEndpoint,
  publishRootKeyBinding,
  type RecordFetcher,
  ROOT_KEY_COLLECTION,
  ROOT_KEY_RECORD_KEY,
  type RootIdentity,
  type RootKeyBinding,
  type RootKeyRecord,
  type RootKeyResolver,
  type RootKeyResolverOptions,
  resolveRootKey,
  revokeRootKeyBinding,
  rootKeyRecord,
  xrpcRecordFetcher,
} from "./root.js"
