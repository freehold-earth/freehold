# @freehold-earth/identity

W3C DID implementation (did:key, ephemeral DIDs) for Freehold identity management.

## Overview

This package provides Decentralized Identifier (DID) functionality for the Freehold ecosystem, implementing the W3C `did:key` method with Ed25519 keys, and accepting an atproto account (`did:plc`, `did:web`) as a root that signs with a locally held key.

**Key concepts:**
- **Root DID**: Persistent user identity; its key is stored encrypted in the context store
- **Ephemeral DID**: Generated per-verification, unlinkable to root or other ephemeral DIDs
- **Root key binding**: For an atproto root, the `earth.freehold.rootKey` record in the account's repository that publishes its Freehold key

## Installation

```bash
pnpm add @freehold-earth/identity
```

## Usage

### Generate a Root DID

```typescript
import { generateDID, serializeDIDKeyPair } from '@freehold-earth/identity';

const rootIdentity = await generateDID();
console.log(rootIdentity.did);
// did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK

// Store encrypted in context store
const serialized = serializeDIDKeyPair(rootIdentity);
```

### Generate Ephemeral DIDs

```typescript
import { generateEphemeralDID } from '@freehold-earth/identity';

// Each ephemeral DID is completely unlinkable
const ephemeral = await generateEphemeralDID();
```

### Sign and Verify

```typescript
import { signWithDID, verifyDIDSignature } from '@freehold-earth/identity';

const message = new TextEncoder().encode('Verification request');
const signature = await signWithDID(keyPair.privateKey, message);

const isValid = await verifyDIDSignature(
  keyPair.publicKey,
  message,
  signature
);
```

### Use an atproto account as the root

```typescript
import {
  generateAuthorizedEphemeralDID,
  generateDID,
  publishRootKeyBinding,
  verifyAuthorizationRecord,
} from '@freehold-earth/identity';

// session: an @atproto/oauth-client session, or any { did, fetchHandler }
// with the repo:earth.freehold.rootKey permission
const keyPair = await generateDID();
const { identity } = await publishRootKeyBinding(session, keyPair);

const { ephemeral, authorization } = await generateAuthorizedEphemeralDID(
  identity, 'Age verification', { verificationType: 'age_over_18' },
);

// Verification resolves the account's published key; inject
// `resolveRootKey` to stay off the network
await verifyAuthorizationRecord(authorization);
```

The private key never leaves the device; deleting the record (`revokeRootKeyBinding`) revokes the binding. No atproto package is required: the session is typed structurally and the calls are plain XRPC over `fetch`.

### Validate DIDs

```typescript
import { isValidDIDKey, didToPublicKey } from '@freehold-earth/identity';

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
- `RootIdentity` - A root DID (`did:key`, `did:plc`, `did:web`) with the keypair that signs for it and, for an external root, the binding it names
- `RootKeyBinding`, `RootKeyRecord` - A published binding as resolved, and as stored
- `AtprotoSession` - The DID and credentialed `fetchHandler` of an atproto OAuth session
- `ApprovalAttestation` - An ephemeral DID and its key's signature over one verification request

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
- `publishRootKeyBinding(session, keyPair, options?)` - Publish the account's Freehold key; returns the root identity to sign with
- `revokeRootKeyBinding(session)` - Delete the binding
- `createRootKeyResolver(options?)` - Resolver from DID document to PDS to binding; `resolveRootKey` is the default one
- `verifyAuthorizationRecord(record, options?)` - Verify a record; `options.resolveRootKey` injects resolution, `options.allowHistoricalKeys` accepts a replaced binding
- `authorizationPreimage(record)` - Canonical bytes a root DID signs for an authorization record
- `attestApproval(requestId, keyPair)` - Sign an approval of one verification request with an ephemeral DID's key
- `verifyApprovalAttestation(requestId, attestation)` - Check an attestation proves possession of its `did:key` for that request
- `approvalPreimage(requestId, requesterDid)` - Canonical bytes an approval attestation signs
- `receiptPreimage(fields)` - Canonical bytes a terms receipt (`spal/receipt/v1`) signs; the operator signs it, not the holder (spec/protocols/terms-receipt.md)
- `encodePreimage(fields)` - Canonical preimage encoding of any registered structure
- `canonicalJson(value)` - RFC 8785 canonical JSON, used for record metadata

### Signed form of authorization records and approvals

An authorization record is signed over the `spal/did-authorization/v2`
structure from [the preimage encoding spec](../spec/protocols/preimage-encoding.md):
a registered domain separator followed by every field with a length prefix, so
moving a boundary between two DIDs can never produce a second record that the
same signature verifies. Any implementation can rebuild the preimage from the
record's fields; the package is tested byte-for-byte against the spec's vectors.

An approval attestation is signed the same way over `spal/did-approval/v1`:
the request id and the ephemeral DID. It proves to whoever holds that
request that the holder of the DID's key approved it, and binds the DID to
that one request. It says nothing about the root DID, which stays in the
authorization record the user keeps.

## Development

```bash
pnpm install
pnpm test       # Run tests
pnpm build      # Build package
pnpm lint       # Type check
```

## Related Packages

- [spec](https://github.com/freehold-earth/freehold/tree/main/spec) - S-PAL schema and protocols
- [context-store](https://github.com/freehold-earth/freehold/tree/main/context-store) - Layer 1: Context Store
- [freehold-agent](https://github.com/freehold-earth/freehold/tree/main/agent) - Layer 2: Personal Agent
- [contracts](https://github.com/freehold-earth/freehold/tree/main/contracts) - Layer 3: Smart Contracts
- [zkp](https://github.com/freehold-earth/freehold/tree/main/zkp) - Layer 4: Zero-Knowledge Proofs

## Future

The planned anchoring path is `did:midnight` via Midnight Passport (ADR-008); `did:prism` is supported in design as an alternative. All are W3C compliant and interoperable.

## License

Apache-2.0
