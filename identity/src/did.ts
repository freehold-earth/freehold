/**
 * DID (Decentralized Identifier) Module
 *
 * Implements W3C did:key method for Freehold identity management.
 * https://w3c-ccg.github.io/did-key-spec/
 *
 * Key concepts:
 * - Root DID: Persistent user identity; a local did:key by default, or an atproto did:plc / did:web bound to a local key (root.ts); anchored via did:midnight (Passport) planned, did:prism as alternative
 * - Ephemeral DID: Generated per-verification, cryptographically linked to root via
 *   authorization records, but unlinkable by third parties
 *
 * Privacy Model:
 * - Third parties CANNOT link ephemeral DIDs to each other or to root
 * - User CAN prove any ephemeral DID belongs to their root (for legal/audit)
 * - Authorization records provide the cryptographic proof of linkage
 *
 * See: docs/concepts/identity-privacy-model.md for full specification
 *
 * Future: anchor root DIDs with did:midnight via Midnight Passport (ADR-008); did:prism remains an alternative
 */

import * as ed from "@noble/ed25519"
import { base64 } from "@scure/base"
import { didToPublicKey, isValidDIDKey, publicKeyToDID } from "./key.js"
import { approvalPreimage, authorizationPreimage } from "./preimage.js"
import {
  CLOCK_TOLERANCE_MS,
  isBindingValidAt,
  isExternalRootDid,
  type RootIdentity,
  type RootKeyResolver,
  resolveRootKey,
} from "./root.js"

export { didToPublicKey, isValidDIDKey, publicKeyToDID }

/**
 * A DID keypair containing the identifier and key material
 */
export interface DIDKeyPair {
  /** The full DID string (e.g., did:key:z6Mk...) */
  did: string
  /** Raw 32-byte Ed25519 public key */
  publicKey: Uint8Array
  /** Raw 32-byte Ed25519 private key (seed) */
  privateKey: Uint8Array
}

/**
 * Serializable format for storing DID in context store
 */
export interface SerializedDIDKeyPair {
  did: string
  publicKey: number[]
  privateKey: number[]
  createdAt: string
}

/**
 * Context information for an authorization record
 */
export interface AuthorizationContext {
  /** Type of verification (e.g., "age_over_18", "employment_status") */
  verificationType: string
  /** DID of the verifier/business requesting verification */
  verifierDid?: string
  /** Hash of the S-PAL policy governing this verification */
  policyHash?: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
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
  ephemeralDid: string
  /** The root DID that authorized this ephemeral DID */
  rootDid: string
  /** Human-readable purpose (e.g., "Age verification at Liquor Store") */
  purpose: string
  /** Machine-readable context */
  context: AuthorizationContext
  /** ISO 8601 timestamp when authorization was created */
  timestamp: string
  /** Optional expiry time (ISO 8601) - ephemeral DID invalid after this */
  expiresAt?: string
  /**
   * CID of the root key binding record the signing key was published under.
   * Set when the root DID is not a did:key, so the record can be checked
   * against the key that was current when it was issued; absent otherwise.
   */
  rootKeyId?: string
  /** Root DID's signature over the record (proves the link) */
  rootSignature: Uint8Array
}

/**
 * Serializable format for storing authorization records
 */
export interface SerializedAuthorizationRecord {
  ephemeralDid: string
  rootDid: string
  purpose: string
  context: AuthorizationContext
  timestamp: string
  expiresAt?: string
  rootKeyId?: string
  rootSignature: number[]
}

/**
 * Result of generating an authorized ephemeral DID
 */
export interface AuthorizedEphemeralDID {
  /** The ephemeral DID keypair */
  ephemeral: DIDKeyPair
  /** The authorization record proving root DID ownership */
  authorization: AuthorizationRecord
}

/**
 * Generate a new did:key from a fresh Ed25519 keypair
 *
 * The DID format is: did:key:z<base58btc(multicodec + publicKey)>
 * where multicodec for Ed25519 is 0xed01
 */
export async function generateDID(): Promise<DIDKeyPair> {
  // Generate random 32-byte private key (seed)
  const privateKey = ed.utils.randomSecretKey()

  // Derive public key from private key
  const publicKey = await ed.getPublicKeyAsync(privateKey)

  // Create did:key identifier
  const did = publicKeyToDID(publicKey)

  return { did, publicKey, privateKey }
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
  return generateDID()
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
 * @param root - The root: a did:key keypair, or a root identity whose DID
 *   is external (did:plc, did:web) and whose key is published as a binding;
 *   the record then names that binding as its `rootKeyId`
 * @param purpose - Human-readable purpose (e.g., "Age verification at Store X")
 * @param context - Machine-readable context for the authorization
 * @param expiresInMs - Optional: milliseconds until ephemeral DID expires
 * @throws Error when a did:key root names a binding, which nothing verifies,
 *   or is not the DID of its own keypair, which nothing could verify
 */
export async function generateAuthorizedEphemeralDID(
  root: DIDKeyPair | RootIdentity,
  purpose: string,
  context: AuthorizationContext,
  expiresInMs?: number,
): Promise<AuthorizedEphemeralDID> {
  const identity: RootIdentity =
    "keyPair" in root ? root : { did: root.did, keyPair: root }
  if (!isExternalRootDid(identity.did)) {
    if (identity.rootKeyId !== undefined) {
      throw new Error("Only an external root DID is verified through a binding")
    }
    if (identity.did !== identity.keyPair.did) {
      throw new Error("A did:key root must be the DID of its own keypair")
    }
  }

  // Generate fresh ephemeral DID (unlinkable)
  const ephemeral = await generateDID()

  const timestamp = new Date().toISOString()
  const expiresAt = expiresInMs
    ? new Date(Date.now() + expiresInMs).toISOString()
    : undefined

  // Create the authorization record (without signature first), keeping the
  // context to the fields the signature covers
  const recordData = {
    ephemeralDid: ephemeral.did,
    rootDid: identity.did,
    purpose,
    context: signedContext(context),
    timestamp,
    expiresAt,
    rootKeyId: identity.rootKeyId,
  }

  // Sign the record's canonical preimage (spal/did-authorization/v2) with the
  // root private key, so no re-partitioning of the fields verifies
  const recordBytes = authorizationPreimage(recordData)
  const rootSignature = await signWithDID(
    identity.keyPair.privateKey,
    recordBytes,
  )

  const authorization: AuthorizationRecord = {
    ...recordData,
    rootSignature,
  }

  return { ephemeral, authorization }
}

/** How a verifier treats roots whose key is published rather than embedded. */
export interface VerifyAuthorizationOptions {
  /**
   * Resolves an external root (did:plc, did:web) to its signing key binding.
   * Defaults to the network resolver; inject one for tests or offline use.
   */
  resolveRootKey?: RootKeyResolver
  /**
   * Accept a record issued under a binding that has since been replaced, by
   * resolving the binding the record names and checking it was valid when
   * the record was issued. Off by default: the record must name the current
   * binding, or none.
   *
   * "When the record was issued" is the record's own timestamp, which the
   * signer sets. A key rotated out because it was compromised can therefore
   * still back-date records into its validity window, bounded only by the
   * binding's `expiresAt`. Enable this only where that is acceptable, such
   * as reading an archive whose records predate a routine rotation. A PDS
   * serves only the current record, so a superseded binding has to come
   * from a resolver with its own store of bindings it saw while current,
   * and that store should set `supersededAt` so the window closes.
   */
  allowHistoricalKeys?: boolean
}

/**
 * Verify an authorization record is valid
 *
 * This proves that an ephemeral DID was authorized by a specific root DID.
 * Used when user voluntarily proves ownership (legal, audit, copyright, etc.)
 *
 * The verifying key comes from the record's own `rootDid`: embedded in it for
 * a did:key, published as a binding for an external root. A valid result
 * therefore means "the root named in this record signed it". A caller who
 * expects a particular root must compare `record.rootDid` with that DID as
 * well.
 *
 * @param record - The authorization record to verify
 * @param options - Resolution of external roots
 * @returns true if the signature is valid and record is not expired; false
 *   for a malformed record (an unparseable expiry, a non-string field, metadata
 *   that is not plain JSON, a context key the signature does not cover, a
 *   signature of the wrong shape) and for an external root with no usable
 *   binding (none published, revoked, expired, or not the one the record
 *   names). A malformed record never throws; a resolver failure does, since
 *   it says nothing about the record.
 */
export async function verifyAuthorizationRecord(
  record: AuthorizationRecord,
  options: VerifyAuthorizationOptions = {},
): Promise<boolean> {
  let recordBytes: Uint8Array
  try {
    // An expiry that does not parse is not "never", it is invalid
    if (isAuthorizationExpired(record)) {
      return false
    }

    // A context key the signature does not cover must not ride along as verified
    if (hasUnsignedContextKeys(record.context)) {
      return false
    }

    // Reconstruct the signed data (without signature)
    recordBytes = authorizationPreimage({
      ephemeralDid: record.ephemeralDid,
      rootDid: record.rootDid,
      purpose: record.purpose,
      context: record.context,
      timestamp: record.timestamp,
      expiresAt: record.expiresAt,
      rootKeyId: record.rootKeyId,
    })
  } catch {
    // Every step reads record-controlled data; a shape it cannot handle is a
    // malformed record, and nothing about it was verified
    return false
  }

  const rootPublicKey = await rootSigningKey(record, options)
  if (rootPublicKey === null) {
    return false // No key to verify against
  }

  try {
    return await verifyDIDSignature(
      rootPublicKey,
      recordBytes,
      record.rootSignature,
    )
  } catch {
    return false // A signature of the wrong shape
  }
}

/**
 * The key a record's root signs with: embedded in a did:key, or the published
 * binding of an external root, which must have been in force when the record
 * was issued and, unless historical keys are allowed, must still be in force.
 */
async function rootSigningKey(
  record: AuthorizationRecord,
  options: VerifyAuthorizationOptions,
): Promise<Uint8Array | null> {
  if (typeof record.rootDid !== "string") return null
  if (!isExternalRootDid(record.rootDid)) {
    // A did:key names no binding; one that does is not a record this
    // layer issued
    if (record.rootKeyId !== undefined) return null
    return didToPublicKey(record.rootDid)
  }
  if (record.rootKeyId !== undefined && typeof record.rootKeyId !== "string") {
    return null
  }
  // The binding must have been in force when the record was issued, which
  // cannot be later than now; unless historical keys are allowed it must
  // also be the binding in force now
  const now = new Date()
  const issuedAt = new Date(record.timestamp)
  if (Number.isNaN(issuedAt.getTime())) return null
  if (issuedAt.getTime() > now.getTime() + CLOCK_TOLERANCE_MS) return null

  // Only a record that names a binding can be checked against a past one
  const resolve = options.resolveRootKey ?? resolveRootKey
  const historical =
    options.allowHistoricalKeys === true && record.rootKeyId !== undefined
  const binding = await resolve(
    record.rootDid,
    historical ? record.rootKeyId : undefined,
  )
  if (binding === null) return null
  if (record.rootKeyId !== undefined && binding.cid !== record.rootKeyId) {
    return null // The record names a binding that is not the one in force
  }
  if (!isBindingValidAt(binding, issuedAt, CLOCK_TOLERANCE_MS)) return null
  if (!historical && !isBindingValidAt(binding, now, CLOCK_TOLERANCE_MS)) {
    return null
  }
  return binding.publicKey
}

/**
 * Check if an authorization record has expired
 */
export function isAuthorizationExpired(record: AuthorizationRecord): boolean {
  if (!record.expiresAt) {
    return false // No expiry set
  }
  const expiryDate = new Date(record.expiresAt)
  return Number.isNaN(expiryDate.getTime()) || expiryDate < new Date()
}

/**
 * Serialize an authorization record for storage
 */
export function serializeAuthorizationRecord(
  record: AuthorizationRecord,
): SerializedAuthorizationRecord {
  return {
    ephemeralDid: record.ephemeralDid,
    rootDid: record.rootDid,
    purpose: record.purpose,
    context: signedContext(record.context),
    timestamp: record.timestamp,
    expiresAt: record.expiresAt,
    rootKeyId: record.rootKeyId,
    rootSignature: Array.from(record.rootSignature),
  }
}

/**
 * Deserialize an authorization record from storage
 */
export function deserializeAuthorizationRecord(
  serialized: SerializedAuthorizationRecord,
): AuthorizationRecord {
  return {
    ephemeralDid: serialized.ephemeralDid,
    rootDid: serialized.rootDid,
    purpose: serialized.purpose,
    context: signedContext(serialized.context),
    timestamp: serialized.timestamp,
    expiresAt: serialized.expiresAt,
    rootKeyId: serialized.rootKeyId,
    rootSignature: new Uint8Array(serialized.rootSignature),
  }
}

/**
 * The context fields the signature covers, and nothing else.
 *
 * A context object is structurally typed, so one read from storage can carry
 * keys the preimage never included; dropping them keeps every field of a
 * stored record tamper-evident.
 */
function signedContext(context: AuthorizationContext): AuthorizationContext {
  const signed: AuthorizationContext = {
    verificationType: context.verificationType,
  }
  if (context.verifierDid !== undefined)
    signed.verifierDid = context.verifierDid
  if (context.policyHash !== undefined) signed.policyHash = context.policyHash
  if (context.metadata !== undefined) signed.metadata = context.metadata
  return signed
}

const SIGNED_CONTEXT_KEYS = new Set([
  "verificationType",
  "verifierDid",
  "policyHash",
  "metadata",
])

function hasUnsignedContextKeys(context: unknown): boolean {
  if (context === null || typeof context !== "object") {
    return false // Left to the preimage encoder to reject
  }
  return Object.keys(context).some((key) => !SIGNED_CONTEXT_KEYS.has(key))
}

/**
 * What the holder of an ephemeral DID signs to approve one verification
 * request. A proof can name any DID; the attestation is how a verifier knows
 * the holder of that DID's key approved this request and no other. It
 * travels with the approval and is never secret: it carries no link to the
 * root DID, which the authorization record keeps private.
 */
export interface ApprovalAttestation {
  /** The ephemeral DID whose key signed; the DID the proof will name */
  requesterDid: string
  /** Ed25519 signature over the `spal/did-approval/v1` preimage, base64 */
  signature: string
}

const ED25519_SIGNATURE_LENGTH = 64

/**
 * Sign an approval of one verification request with an ephemeral DID's key.
 *
 * @param requestId - The verification request being approved, as the agent identifies it
 * @param keyPair - The ephemeral DID and the key that signs for it
 */
export async function attestApproval(
  requestId: string,
  keyPair: DIDKeyPair,
): Promise<ApprovalAttestation> {
  const signature = await ed.signAsync(
    approvalPreimage(requestId, keyPair.did),
    keyPair.privateKey,
  )
  return { requesterDid: keyPair.did, signature: base64.encode(signature) }
}

/**
 * Verify that an attestation proves possession of its DID's key for this request.
 *
 * The verifying key comes from the DID itself, so only a `did:key` Ed25519
 * DID can be checked; any other DID is unverifiable here and fails. Returns
 * false, never throws, for a malformed attestation: a field that is not a
 * string, a signature that is not the base64 of 64 bytes, or text the
 * preimage encoding rejects. A verifier that expects a particular DID must
 * compare `requesterDid` with it as well.
 *
 * @param requestId - The request the verifier holds, which the attestation must name
 * @param attestation - The attestation that came with the approval
 */
export async function verifyApprovalAttestation(
  requestId: string,
  attestation: ApprovalAttestation,
): Promise<boolean> {
  if (
    typeof attestation?.requesterDid !== "string" ||
    typeof attestation.signature !== "string"
  ) {
    return false
  }
  const publicKey = didToPublicKey(attestation.requesterDid)
  if (!publicKey) {
    return false
  }
  try {
    const signature = base64.decode(attestation.signature)
    if (signature.length !== ED25519_SIGNATURE_LENGTH) {
      return false
    }
    const preimage = approvalPreimage(requestId, attestation.requesterDid)
    return await ed.verifyAsync(signature, preimage, publicKey)
  } catch {
    return false
  }
}

/**
 * Sign data with a DID's private key
 */
export async function signWithDID(
  privateKey: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey)
}

/**
 * Verify a signature against a DID's public key
 */
export async function verifyDIDSignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return ed.verifyAsync(signature, message, publicKey)
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
  }
}

/**
 * Deserialize a DID keypair from storage
 */
export function deserializeDIDKeyPair(
  serialized: SerializedDIDKeyPair,
): DIDKeyPair {
  return {
    did: serialized.did,
    publicKey: new Uint8Array(serialized.publicKey),
    privateKey: new Uint8Array(serialized.privateKey),
  }
}

/**
 * Truncate a DID for display (e.g., "did:key:z6Mk...xYz")
 */
export function truncateDID(
  did: string,
  prefixLen = 12,
  suffixLen = 4,
): string {
  if (did.length <= prefixLen + suffixLen + 3) {
    return did
  }
  return `${did.slice(0, prefixLen)}...${did.slice(-suffixLen)}`
}
