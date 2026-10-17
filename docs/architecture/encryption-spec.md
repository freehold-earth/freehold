# PCI Encryption Specification

**Status:** Draft
**Version:** 1.0
**Date:** 2025-12-10

## Overview

This document specifies the encryption format used by PCI Context Store. Any client implementation in any language that follows this spec will be interoperable with the PCI ecosystem.

## Design Principles

1. **Client-side encryption** - All encryption/decryption happens on the client. The server never sees plaintext or keys.
2. **Zero-knowledge server** - The server stores only encrypted blobs.
3. **Standard algorithms** - Uses widely-supported cryptographic primitives available in all languages.
4. **Interoperability** - Any language implementing this spec can encrypt/decrypt PCI data.

## Encryption Algorithm

### Symmetric Encryption

- **Algorithm:** AES-256-GCM (Galois/Counter Mode)
- **Key size:** 256 bits (32 bytes)
- **IV/Nonce size:** 96 bits (12 bytes)
- **Authentication tag size:** 128 bits (16 bytes)

### Key Derivation (Password-based)

- **Algorithm:** PBKDF2
- **Hash function:** SHA-256
- **Iterations:** 100,000
- **Salt size:** 256 bits (32 bytes)
- **Output key size:** 256 bits (32 bytes)

## Data Format

### EncryptedData Object

All encrypted data is represented as a JSON object with the following fields:

```json
{
  "ciphertext": "<base64-encoded ciphertext>",
  "iv": "<base64-encoded initialization vector>",
  "authTag": "<base64-encoded authentication tag>",
  "salt": "<base64-encoded salt, only if password-derived key>"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ciphertext` | string | Yes | Base64-encoded encrypted data |
| `iv` | string | Yes | Base64-encoded 12-byte initialization vector |
| `authTag` | string | Yes | Base64-encoded 16-byte authentication tag |
| `salt` | string | No | Base64-encoded 32-byte salt (present if key was derived from password) |

### Encoding

- All binary data is encoded as **Base64** (standard alphabet, with padding)
- Plaintext is encoded as **UTF-8** before encryption
- The encrypted data object is serialized as **JSON**

## Operations

### Encrypt with Password

```
Input:
  - plaintext: UTF-8 string
  - password: UTF-8 string

Process:
  1. Generate random 32-byte salt
  2. Derive key: PBKDF2(password, salt, iterations=100000, hash=SHA-256, keylen=32)
  3. Generate random 12-byte IV
  4. Encrypt: AES-256-GCM(key, IV, plaintext)
  5. Extract 16-byte authentication tag

Output:
  {
    "ciphertext": base64(encrypted_bytes),
    "iv": base64(iv),
    "authTag": base64(auth_tag),
    "salt": base64(salt)
  }
```

### Decrypt with Password

```
Input:
  - encrypted: EncryptedData object
  - password: UTF-8 string

Process:
  1. Decode salt from base64
  2. Derive key: PBKDF2(password, salt, iterations=100000, hash=SHA-256, keylen=32)
  3. Decode IV, ciphertext, authTag from base64
  4. Decrypt: AES-256-GCM(key, IV, ciphertext, authTag)

Output:
  - plaintext: UTF-8 string

Errors:
  - Throw error if authentication fails (wrong password or tampered data)
```

### Encrypt with Raw Key

Same as above, but:
- Skip steps 1-2 (salt generation and key derivation)
- Use provided 32-byte key directly
- Do not include `salt` field in output

### Decrypt with Raw Key

Same as above, but:
- Skip steps 1-2 (salt decoding and key derivation)
- Use provided 32-byte key directly

## Reference Implementations

### TypeScript/Node.js (pci-context-store)

```typescript
// Uses Node.js crypto module
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';

function encrypt(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}
```

### Browser (WebCrypto)

```typescript
// Uses Web Crypto API
async function encrypt(plaintext: string, key: CryptoKey): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // WebCrypto appends authTag to ciphertext
  const ctArray = new Uint8Array(ciphertext);
  const actualCiphertext = ctArray.slice(0, -16);
  const authTag = ctArray.slice(-16);

  return {
    ciphertext: bufferToBase64(actualCiphertext),
    iv: bufferToBase64(iv),
    authTag: bufferToBase64(authTag),
  };
}
```

### Python

```python
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import os, base64

def encrypt(plaintext: str, key: bytes) -> dict:
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext_with_tag = aesgcm.encrypt(iv, plaintext.encode('utf-8'), None)
    ciphertext = ciphertext_with_tag[:-16]
    auth_tag = ciphertext_with_tag[-16:]

    return {
        'ciphertext': base64.b64encode(ciphertext).decode(),
        'iv': base64.b64encode(iv).decode(),
        'authTag': base64.b64encode(auth_tag).decode(),
    }
```

### Rust

```rust
use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, NewAead};
use base64::{encode, decode};
use rand::Rng;

fn encrypt(plaintext: &str, key: &[u8; 32]) -> EncryptedData {
    let key = Key::from_slice(key);
    let cipher = Aes256Gcm::new(key);
    let nonce_bytes: [u8; 12] = rand::thread_rng().gen();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext_with_tag = cipher.encrypt(nonce, plaintext.as_bytes()).unwrap();
    let (ciphertext, auth_tag) = ciphertext_with_tag.split_at(ciphertext_with_tag.len() - 16);

    EncryptedData {
        ciphertext: encode(ciphertext),
        iv: encode(nonce_bytes),
        auth_tag: encode(auth_tag),
        salt: None,
    }
}
```

## Security Considerations

1. **Never reuse IVs** - Always generate a fresh random IV for each encryption operation
2. **Use constant-time comparison** for authentication tags when implementing manually
3. **Clear sensitive data** from memory after use (keys, plaintext)
4. **Use secure random** number generators for IV and salt generation
5. **Validate inputs** - Check key length, IV length before operations

## Storage Format

When storing encrypted data in the context store server, the client sends:

```json
{
  "encrypted_data": "<JSON-serialized EncryptedData object>"
}
```

The server stores this string as-is without parsing or modification.

## Future Considerations

- **Key rotation** - Mechanism for re-encrypting data with new keys
- **Multiple encryption layers** - For shared data scenarios
- **Hardware key storage** - Integration with secure enclaves, TPMs
- **Post-quantum** - Migration path to post-quantum algorithms when standardized
