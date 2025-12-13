# pci-identity

W3C DID implementation (did:key, ephemeral DIDs) for PCI identity management.

## Overview

This package provides Decentralized Identifier (DID) functionality for the PCI ecosystem, implementing the W3C `did:key` method with Ed25519 keys.

**Key concepts:**
- **Root DID**: Persistent user identity, stored encrypted in context store
- **Ephemeral DID**: Generated per-verification, unlinkable to root or other ephemeral DIDs

## Installation

```bash
pnpm add pci-identity
```

## Usage

### Generate a Root DID

```typescript
import { generateDID, serializeDIDKeyPair } from 'pci-identity';

const rootIdentity = await generateDID();
console.log(rootIdentity.did);
// did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK

// Store encrypted in context store
const serialized = serializeDIDKeyPair(rootIdentity);
```

### Generate Ephemeral DIDs

```typescript
import { generateEphemeralDID } from 'pci-identity';

// Each ephemeral DID is completely unlinkable
const ephemeral = await generateEphemeralDID();
```

### Sign and Verify

```typescript
import { signWithDID, verifyDIDSignature } from 'pci-identity';

const message = new TextEncoder().encode('Verification request');
const signature = await signWithDID(keyPair.privateKey, message);

const isValid = await verifyDIDSignature(
  keyPair.publicKey,
  message,
  signature
);
```

### Validate DIDs

```typescript
import { isValidDIDKey, didToPublicKey } from 'pci-identity';

if (isValidDIDKey(did)) {
  const publicKey = didToPublicKey(did);
}
```

## DID Format

Using W3C `did:key` method:

```
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
        │ └─ base58-btc encoded (multicodec + public key)
        └─ 'z' prefix indicates base58-btc encoding
```

## API

### Types

- `DIDKeyPair` - Contains `did`, `publicKey`, and `privateKey`
- `SerializedDIDKeyPair` - JSON-serializable format for storage

### Functions

- `generateDID()` - Generate a new did:key
- `generateEphemeralDID()` - Generate an unlinkable ephemeral DID
- `publicKeyToDID(publicKey)` - Convert public key to DID
- `didToPublicKey(did)` - Extract public key from DID
- `signWithDID(privateKey, message)` - Sign data
- `verifyDIDSignature(publicKey, message, signature)` - Verify signature
- `isValidDIDKey(did)` - Check DID validity
- `serializeDIDKeyPair(keyPair)` - Serialize for storage
- `deserializeDIDKeyPair(serialized)` - Deserialize from storage
- `truncateDID(did)` - Truncate for display

## Development

```bash
pnpm install
pnpm test       # Run tests
pnpm build      # Build package
pnpm lint       # Type check
```

## Future

Migration path to `did:prism` for Cardano-anchored identity is planned. Both methods are W3C compliant and interoperable.

## License

Apache-2.0
