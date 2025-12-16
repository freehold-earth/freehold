/**
 * DID (Decentralized Identifier) Module
 *
 * Implements W3C did:key method for PCI identity management.
 * https://w3c-ccg.github.io/did-key-spec/
 *
 * Key concepts:
 * - Root DID: Persistent user identity, anchored on-chain (did:prism) or local (did:key)
 * - Ephemeral DID: Generated per-verification, cryptographically linked to root via
 *   authorization records, but unlinkable by third parties
 *
 * Privacy Model:
 * - Third parties CANNOT link ephemeral DIDs to each other or to root
 * - User CAN prove any ephemeral DID belongs to their root (for legal/audit)
 * - Authorization records provide the cryptographic proof of linkage
 *
 * See: pci-docs/PCI_Identity_Privacy_Model.md for full specification
 *
 * Future: Migrate to did:prism for Cardano-anchored identity
 */

import * as ed from "@noble/ed25519";
import { base58 } from "@scure/base";

// Ed25519 multicodec prefix (0xed01)
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

/**
 * A DID keypair containing the identifier and key material
 */
export interface DIDKeyPair {
  /** The full DID string (e.g., did:key:z6Mk...) */
  did: string;
  /** Raw 32-byte Ed25519 public key */
  publicKey: Uint8Array;
  /** Raw 32-byte Ed25519 private key (seed) */
  privateKey: Uint8Array;
}

/**
 * Serializable format for storing DID in context store
 */
export interface SerializedDIDKeyPair {
  did: string;
  publicKey: number[];
  privateKey: number[];
  createdAt: string;
}

/**
 * Context information for an authorization record
 */
export interface AuthorizationContext {
  /** Type of verification (e.g., "age_over_18", "employment_status") */
  verificationType: string;
  /** DID of the verifier/business requesting verification */
  verifierDid?: string;
  /** Hash of the S-PAL policy governing this verification */
  policyHash?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Authorization record linking an ephemeral DID to a root DID
 *
 * This record is stored locally (encrypted) and provides cryptographic
 * proof that the ephemeral DID was authorized by the root DID.
 *
 * Privacy: The record is NEVER shared with verifiers. It is only used
 * when the user voluntarily proves ownership (legal, audit, copyright, etc.)
 */
export interface AuthorizationRecord {
  /** The ephemeral DID that was authorized */
  ephemeralDid: string;
  /** The root DID that authorized this ephemeral DID */
  rootDid: string;
  /** Human-readable purpose (e.g., "Age verification at Liquor Store") */
  purpose: string;
  /** Machine-readable context */
  context: AuthorizationContext;
  /** ISO 8601 timestamp when authorization was created */
  timestamp: string;
  /** Optional expiry time (ISO 8601) - ephemeral DID invalid after this */
  expiresAt?: string;
  /** Root DID's signature over the record (proves the link) */
  rootSignature: Uint8Array;
}

/**
 * Serializable format for storing authorization records
 */
export interface SerializedAuthorizationRecord {
  ephemeralDid: string;
  rootDid: string;
  purpose: string;
  context: AuthorizationContext;
  timestamp: string;
  expiresAt?: string;
  rootSignature: number[];
}

/**
 * Result of generating an authorized ephemeral DID
 */
export interface AuthorizedEphemeralDID {
  /** The ephemeral DID keypair */
  ephemeral: DIDKeyPair;
  /** The authorization record proving root DID ownership */
  authorization: AuthorizationRecord;
}

/**
 * Generate a new did:key from a fresh Ed25519 keypair
 *
 * The DID format is: did:key:z<base58btc(multicodec + publicKey)>
 * where multicodec for Ed25519 is 0xed01
 */
export async function generateDID(): Promise<DIDKeyPair> {
  // Generate random 32-byte private key (seed)
  const privateKey = ed.utils.randomSecretKey();

  // Derive public key from private key
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  // Create did:key identifier
  const did = publicKeyToDID(publicKey);

  return { did, publicKey, privateKey };
}

/**
 * Convert a raw Ed25519 public key to a did:key identifier
 */
export function publicKeyToDID(publicKey: Uint8Array): string {
  // Prepend multicodec header
  const multicodecKey = new Uint8Array(
    ED25519_MULTICODEC.length + publicKey.length
  );
  multicodecKey.set(ED25519_MULTICODEC);
  multicodecKey.set(publicKey, ED25519_MULTICODEC.length);

  // Encode as base58 with 'z' prefix (base58btc multibase prefix)
  const encoded = base58.encode(multicodecKey);

  return `did:key:z${encoded}`;
}

/**
 * Generate an ephemeral DID that is unlinkable to the root DID
 *
 * Each ephemeral DID is a fresh keypair - completely independent.
 * Third parties cannot link this to the root DID or other ephemeral DIDs.
 *
 * NOTE: For most use cases, prefer generateAuthorizedEphemeralDID() which
 * creates an authorization record for later proof of ownership.
 */
export async function generateEphemeralDID(): Promise<DIDKeyPair> {
  // Ephemeral DIDs are fresh random keypairs
  // This ensures complete unlinkability by third parties
  return generateDID();
}

/**
 * Generate an ephemeral DID with an authorization record
 *
 * This is the preferred method for creating ephemeral DIDs because it:
 * 1. Creates a fresh, unlinkable ephemeral DID
 * 2. Creates an authorization record signed by the root DID
 * 3. The authorization record can later prove ownership (for legal/audit)
 *
 * Privacy: The authorization record is stored locally and NEVER shared
 * with verifiers. Only the ephemeral DID is shared during verification.
 *
 * @param rootKeyPair - The root DID keypair
 * @param purpose - Human-readable purpose (e.g., "Age verification at Store X")
 * @param context - Machine-readable context for the authorization
 * @param expiresInMs - Optional: milliseconds until ephemeral DID expires
 */
export async function generateAuthorizedEphemeralDID(
  rootKeyPair: DIDKeyPair,
  purpose: string,
  context: AuthorizationContext,
  expiresInMs?: number
): Promise<AuthorizedEphemeralDID> {
  // Generate fresh ephemeral DID (unlinkable)
  const ephemeral = await generateDID();

  const timestamp = new Date().toISOString();
  const expiresAt = expiresInMs
    ? new Date(Date.now() + expiresInMs).toISOString()
    : undefined;

  // Create the authorization record (without signature first)
  const recordData = {
    ephemeralDid: ephemeral.did,
    rootDid: rootKeyPair.did,
    purpose,
    context,
    timestamp,
    expiresAt,
  };

  // Sign the record with root DID private key
  const recordBytes = new TextEncoder().encode(JSON.stringify(recordData));
  const rootSignature = await signWithDID(rootKeyPair.privateKey, recordBytes);

  const authorization: AuthorizationRecord = {
    ...recordData,
    rootSignature,
  };

  return { ephemeral, authorization };
}

/**
 * Verify an authorization record is valid
 *
 * This proves that an ephemeral DID was authorized by a specific root DID.
 * Used when user voluntarily proves ownership (legal, audit, copyright, etc.)
 *
 * @param record - The authorization record to verify
 * @returns true if the signature is valid and record is not expired
 */
export async function verifyAuthorizationRecord(
  record: AuthorizationRecord
): Promise<boolean> {
  // Check expiry
  if (record.expiresAt) {
    const expiryDate = new Date(record.expiresAt);
    if (expiryDate < new Date()) {
      return false; // Expired
    }
  }

  // Extract root DID public key
  const rootPublicKey = didToPublicKey(record.rootDid);
  if (!rootPublicKey) {
    return false; // Invalid root DID format
  }

  // Reconstruct the signed data (without signature)
  const recordData = {
    ephemeralDid: record.ephemeralDid,
    rootDid: record.rootDid,
    purpose: record.purpose,
    context: record.context,
    timestamp: record.timestamp,
    expiresAt: record.expiresAt,
  };

  const recordBytes = new TextEncoder().encode(JSON.stringify(recordData));

  // Verify signature
  return verifyDIDSignature(rootPublicKey, recordBytes, record.rootSignature);
}

/**
 * Check if an authorization record has expired
 */
export function isAuthorizationExpired(record: AuthorizationRecord): boolean {
  if (!record.expiresAt) {
    return false; // No expiry set
  }
  return new Date(record.expiresAt) < new Date();
}

/**
 * Serialize an authorization record for storage
 */
export function serializeAuthorizationRecord(
  record: AuthorizationRecord
): SerializedAuthorizationRecord {
  return {
    ephemeralDid: record.ephemeralDid,
    rootDid: record.rootDid,
    purpose: record.purpose,
    context: record.context,
    timestamp: record.timestamp,
    expiresAt: record.expiresAt,
    rootSignature: Array.from(record.rootSignature),
  };
}

/**
 * Deserialize an authorization record from storage
 */
export function deserializeAuthorizationRecord(
  serialized: SerializedAuthorizationRecord
): AuthorizationRecord {
  return {
    ephemeralDid: serialized.ephemeralDid,
    rootDid: serialized.rootDid,
    purpose: serialized.purpose,
    context: serialized.context,
    timestamp: serialized.timestamp,
    expiresAt: serialized.expiresAt,
    rootSignature: new Uint8Array(serialized.rootSignature),
  };
}

/**
 * Sign data with a DID's private key
 */
export async function signWithDID(
  privateKey: Uint8Array,
  message: Uint8Array
): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey);
}

/**
 * Verify a signature against a DID's public key
 */
export async function verifyDIDSignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  return ed.verifyAsync(signature, message, publicKey);
}

/**
 * Extract the public key from a did:key identifier
 */
export function didToPublicKey(did: string): Uint8Array | null {
  if (!did.startsWith("did:key:z")) {
    return null;
  }

  try {
    const encoded = did.slice(9); // Remove "did:key:z"
    const decoded = base58.decode(encoded);

    // Check multicodec prefix
    if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
      return null; // Not an Ed25519 key
    }

    // Return public key bytes (skip 2-byte multicodec header)
    return decoded.slice(2);
  } catch {
    return null;
  }
}

/**
 * Check if a DID is a valid did:key format
 */
export function isValidDIDKey(did: string): boolean {
  if (!did.startsWith("did:key:z")) {
    return false;
  }

  const publicKey = didToPublicKey(did);
  return publicKey !== null && publicKey.length === 32;
}

/**
 * Serialize a DID keypair for encrypted storage
 */
export function serializeDIDKeyPair(keyPair: DIDKeyPair): SerializedDIDKeyPair {
  return {
    did: keyPair.did,
    publicKey: Array.from(keyPair.publicKey),
    privateKey: Array.from(keyPair.privateKey),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Deserialize a DID keypair from storage
 */
export function deserializeDIDKeyPair(
  serialized: SerializedDIDKeyPair
): DIDKeyPair {
  return {
    did: serialized.did,
    publicKey: new Uint8Array(serialized.publicKey),
    privateKey: new Uint8Array(serialized.privateKey),
  };
}

/**
 * Truncate a DID for display (e.g., "did:key:z6Mk...xYz")
 */
export function truncateDID(did: string, prefixLen = 12, suffixLen = 4): string {
  if (did.length <= prefixLen + suffixLen + 3) {
    return did;
  }
  return `${did.slice(0, prefixLen)}...${did.slice(-suffixLen)}`;
}
