/**
 * The did:key form of an Ed25519 public key: multicodec 0xed01, base58btc,
 * multibase prefix `z`. https://w3c-ccg.github.io/did-key-spec/
 */

import { base58 } from "@scure/base"

const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01])

/**
 * Convert a raw Ed25519 public key to a did:key identifier
 */
export function publicKeyToDID(publicKey: Uint8Array): string {
  // Prepend multicodec header
  const multicodecKey = new Uint8Array(
    ED25519_MULTICODEC.length + publicKey.length,
  )
  multicodecKey.set(ED25519_MULTICODEC)
  multicodecKey.set(publicKey, ED25519_MULTICODEC.length)

  // Encode as base58 with 'z' prefix (base58btc multibase prefix)
  const encoded = base58.encode(multicodecKey)

  return `did:key:z${encoded}`
}

/**
 * Extract the public key from a did:key identifier; null for anything that is
 * not the did:key form of a 32-byte Ed25519 key
 */
export function didToPublicKey(did: string): Uint8Array | null {
  if (!did.startsWith("did:key:z")) {
    return null
  }

  try {
    const encoded = did.slice(9) // Remove "did:key:z"
    const decoded = base58.decode(encoded)

    // Check multicodec prefix and that exactly a 32-byte key follows it
    if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
      return null // Not an Ed25519 key
    }

    // Return public key bytes (skip 2-byte multicodec header)
    return decoded.slice(2)
  } catch {
    return null
  }
}

/**
 * Check if a DID is a valid did:key format
 */
export function isValidDIDKey(did: string): boolean {
  if (!did.startsWith("did:key:z")) {
    return false
  }

  const publicKey = didToPublicKey(did)
  return publicKey !== null && publicKey.length === 32
}
