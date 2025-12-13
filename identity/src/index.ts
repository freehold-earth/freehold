/**
 * PCI Identity - W3C DID implementation for PCI
 *
 * @packageDocumentation
 */

export {
  // Types
  type DIDKeyPair,
  type SerializedDIDKeyPair,
  // Core functions
  generateDID,
  generateEphemeralDID,
  publicKeyToDID,
  didToPublicKey,
  // Signing/verification
  signWithDID,
  verifyDIDSignature,
  // Validation
  isValidDIDKey,
  // Serialization
  serializeDIDKeyPair,
  deserializeDIDKeyPair,
  // Display
  truncateDID,
} from "./did.js";
