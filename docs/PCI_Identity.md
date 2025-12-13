# PCI Identity (`pci-identity`)

**Repository:** `pci-identity`
**Status:** Design
**Language:** TypeScript (ESM)

## Overview

The `pci-identity` package provides W3C-compliant Decentralized Identifier (DID) functionality for the PCI ecosystem. It implements the `did:key` method for immediate use and is designed for future migration to `did:prism` for Cardano-anchored identity.

## Key Concepts

### Root DID (Persistent Identity)
- Generated once per user, on first unlock
- Stored encrypted in the context store
- Never shared with external parties
- Used only to derive ephemeral identities

### Ephemeral DID (Per-Interaction Identity)
- Generated fresh for each verification request
- Cryptographically unlinkable to root DID or other ephemeral DIDs
- Provides privacy: businesses cannot correlate interactions
- Bound to ZKP proofs for authenticity

## DID Format

Using `did:key` method (W3C DID specification):

```
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
        │ └─ base58-btc encoded (multicodec + public key)
        └─ 'z' prefix indicates base58-btc encoding
```

Encoding: `MULTIBASE(base58-btc, MULTICODEC(0xed, raw-ed25519-public-key-bytes))`

Where `0xed01` is the multicodec prefix for Ed25519 public keys.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      User App                            │
├─────────────────────────────────────────────────────────┤
│  Root DID (persistent)                                   │
│  ├── Generated on first unlock                          │
│  ├── Stored encrypted in context store                  │
│  └── Never exposed to external services                 │
│                                                          │
│  Ephemeral DID (per-verification)                       │
│  ├── Fresh Ed25519 keypair per request                  │
│  ├── Used for single verification request               │
│  └── Unlinkable to root or other ephemeral DIDs         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                      Agent                               │
├─────────────────────────────────────────────────────────┤
│  Receives: ephemeral DID + proof request                │
│  Passes: ephemeral DID to ZKP service                   │
│  Returns: proof bound to ephemeral DID                  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  S-PAL Contract                          │
├─────────────────────────────────────────────────────────┤
│  Validates:                                              │
│  ├── DID format is valid did:key                        │
│  ├── If requires_ephemeral_did: DID is ephemeral        │
│  └── Proof is bound to requester_did                    │
└─────────────────────────────────────────────────────────┘
```

## API Reference

### Core Types

```typescript
/**
 * A DID keypair containing the identifier and key material
 */
interface DIDKeyPair {
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
interface SerializedDIDKeyPair {
  did: string;
  publicKey: number[];
  privateKey: number[];
  createdAt: string;
}
```

### Functions

#### `generateDID(): Promise<DIDKeyPair>`

Generate a new `did:key` from a fresh Ed25519 keypair.

```typescript
const rootIdentity = await generateDID();
// rootIdentity.did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
```

#### `generateEphemeralDID(): Promise<DIDKeyPair>`

Generate an ephemeral DID that is unlinkable to any other DID. Currently generates a fresh keypair (complete unlinkability).

```typescript
const ephemeral = await generateEphemeralDID();
// Use for single verification request
```

#### `publicKeyToDID(publicKey: Uint8Array): string`

Convert a raw Ed25519 public key to a `did:key` identifier.

#### `didToPublicKey(did: string): Uint8Array | null`

Extract the raw public key from a `did:key` identifier. Returns `null` for invalid DIDs.

#### `signWithDID(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>`

Sign data with a DID's private key using Ed25519.

#### `verifyDIDSignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>`

Verify a signature against a DID's public key.

#### `isValidDIDKey(did: string): boolean`

Check if a DID is a valid `did:key` format with Ed25519 key.

#### `serializeDIDKeyPair(keyPair: DIDKeyPair): SerializedDIDKeyPair`

Serialize a DID keypair for encrypted storage.

#### `deserializeDIDKeyPair(serialized: SerializedDIDKeyPair): DIDKeyPair`

Deserialize a DID keypair from storage.

#### `truncateDID(did: string, prefixLen?: number, suffixLen?: number): string`

Truncate a DID for display (e.g., `"did:key:z6Mk...xYz"`).

## Dependencies

```json
{
  "@noble/ed25519": "^3.0.0",
  "@scure/base": "^2.0.0"
}
```

These libraries are chosen for:
- **Security**: Audited, production-grade cryptography
- **Browser compatibility**: Pure JavaScript, no native dependencies
- **Size**: Minimal bundle footprint

## Security Considerations

### Private Key Protection
- Root private key is stored encrypted in the context store
- Private keys never leave the user's device
- Ephemeral private keys can be discarded after signing

### Unlinkability
- Ephemeral DIDs are completely fresh keypairs
- No cryptographic link between root and ephemeral DIDs
- Even quantum computers cannot link ephemeral to root

### Attack Vectors
- **Key extraction**: Mitigated by context store encryption
- **Correlation attacks**: Prevented by fresh ephemeral keypairs
- **Replay attacks**: Proofs bound to specific DIDs and timestamps

## Cardano & Midnight Ecosystem Alignment

### did:prism (Future)

[PRISM DID method](https://github.com/input-output-hk/prism-did-method-spec/blob/main/w3c-spec/PRISM-method.md) is W3C compliant and registered in the W3C DID Specification registry.

Format: `did:prism:[64-char-hex-hash]`

Key features:
- Operations anchored on Cardano mainnet via transaction metadata
- Supports Ed25519, secp256k1, X25519 key types
- Full W3C verification relationships (authentication, assertion, key agreement)
- [Atala PRISM](https://atalaprism.io/) provides tooling and enterprise agent

### Midnight Integration

[IAMX is partnering with Midnight](https://midnight.network/blog/state-of-the-network-april-2025) for DID + data protection. Midnight's ZKP capabilities align well with ephemeral DIDs - can prove DID validity without revealing the DID itself.

### Migration Path

1. **Current**: `did:key` for fast iteration (no on-chain anchor needed)
2. **Future**: Migrate to `did:prism` for Cardano-anchored identity

Both methods are W3C compliant and interoperable.

## Usage Examples

### Creating a Root Identity

```typescript
import { generateDID, serializeDIDKeyPair } from '@pci/identity';
import { contextStore } from '@pci/context-store';

// On first user unlock
const rootDID = await generateDID();
await contextStore.put('identity', serializeDIDKeyPair(rootDID));
```

### Verification Flow with Ephemeral DID

```typescript
import { generateEphemeralDID, signWithDID } from '@pci/identity';

// User approves verification request
const ephemeral = await generateEphemeralDID();

// Create signed verification payload
const payload = new TextEncoder().encode(JSON.stringify({
  request_id: requestId,
  timestamp: Date.now(),
  ephemeral_did: ephemeral.did,
}));

const signature = await signWithDID(ephemeral.privateKey, payload);

// Send to agent
await fetch(`${API_URL}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ephemeral_did: ephemeral.did,
    payload: Array.from(payload),
    signature: Array.from(signature),
  }),
});
```

### Contract Validation (Aiken)

```aiken
fn is_valid_did_key(did: ByteArray) -> Bool {
  // Check starts with "did:key:z" (9 bytes)
  let prefix = #"6469643a6b65793a7a"  // "did:key:z" in hex
  bytearray.take(did, 9) == prefix
}

fn check_ephemeral_did(requester_did: ByteArray, requires_ephemeral: Bool) -> Bool {
  if requires_ephemeral {
    // Ephemeral DIDs must be valid did:key format
    is_valid_did_key(requester_did)
  } else {
    True
  }
}
```

## Related Documentation

- [DID Implementation Plan](/plans/DID_IMPLEMENTATION.md)
- [Technical Appendix - DID Section](PCI_Technical_Appendix.md#did-implementation)
- [W3C did:key Specification](https://w3c-ccg.github.io/did-key-spec/)
- [PRISM DID Method Spec](https://github.com/input-output-hk/prism-did-method-spec)
