/**
 * DID (Decentralized Identifier) Module
 *
 * Implements W3C did:key method for PCI identity management.
 * https://w3c-ccg.github.io/did-key-spec/
 *
 * Key concepts:
 * - Root DID: Persistent user identity, stored encrypted in context store
 * - Ephemeral DID: Generated per-verification, unlinkable to root or other ephemeral DIDs
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
 * The root private key is used only to sign the ephemeral DID,
 * proving ownership without linking.
 */
export async function generateEphemeralDID(): Promise<DIDKeyPair> {
  // For now, ephemeral DIDs are simply fresh keypairs
  // This ensures complete unlinkability
  //
  // In the future, we could use hierarchical deterministic derivation
  // with a random path, but fresh keys are simpler and equally secure
  return generateDID();
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
