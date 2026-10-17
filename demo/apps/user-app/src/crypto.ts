/**
 * Browser-compatible cryptography using WebCrypto API
 *
 * Implements AES-256-GCM encryption with PBKDF2 key derivation.
 * This matches the pci-context-store library format for interoperability.
 *
 * IMPORTANT: All encryption happens client-side. The server never sees
 * plaintext data or encryption keys.
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256; // bits
const IV_LENGTH = 12; // bytes
const SALT_LENGTH = 32; // bytes
const PBKDF2_ITERATIONS = 100000;

/**
 * Encrypted data format (matches pci-context-store)
 */
export interface EncryptedData {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded authentication tag (included in ciphertext for WebCrypto) */
  authTag: string;
  /** Base64-encoded salt (if key was derived from password) */
  salt?: string;
}

/**
 * Convert Uint8Array to Base64 string
 */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer
 */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Generate a random encryption key
 */
export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true, // extractable
    ["encrypt", "decrypt"]
  );
}

/**
 * Derive an encryption key from a password using PBKDF2
 */
export async function deriveKey(
  password: string,
  salt?: Uint8Array
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  // Derive the actual encryption key
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: actualSalt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    true, // extractable
    ["encrypt", "decrypt"]
  );

  return { key, salt: actualSalt };
}

/**
 * Encrypt data using AES-256-GCM
 */
export async function encrypt(
  plaintext: string,
  key: CryptoKey
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encodedData = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encodedData
  );

  // WebCrypto includes the auth tag at the end of ciphertext
  // Extract it for compatibility with Node.js format
  const ciphertextArray = new Uint8Array(ciphertext);
  const authTagStart = ciphertextArray.length - 16;
  const actualCiphertext = ciphertextArray.slice(0, authTagStart);
  const authTag = ciphertextArray.slice(authTagStart);

  return {
    ciphertext: uint8ToBase64(actualCiphertext),
    iv: uint8ToBase64(iv),
    authTag: uint8ToBase64(authTag),
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
export async function decrypt(
  encrypted: EncryptedData,
  key: CryptoKey
): Promise<string> {
  const iv = new Uint8Array(base64ToBuffer(encrypted.iv));
  const ciphertext = new Uint8Array(base64ToBuffer(encrypted.ciphertext));
  const authTag = new Uint8Array(base64ToBuffer(encrypted.authTag));

  // Reconstruct the full ciphertext (WebCrypto expects auth tag appended)
  const fullCiphertext = new Uint8Array(ciphertext.length + authTag.length);
  fullCiphertext.set(ciphertext);
  fullCiphertext.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    fullCiphertext
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypt data with a password (derives key automatically)
 */
export async function encryptWithPassword(
  plaintext: string,
  password: string
): Promise<EncryptedData> {
  const { key, salt } = await deriveKey(password);
  const result = await encrypt(plaintext, key);
  result.salt = uint8ToBase64(salt);
  return result;
}

/**
 * Decrypt data with a password (derives key from stored salt)
 */
export async function decryptWithPassword(
  encrypted: EncryptedData,
  password: string
): Promise<string> {
  if (!encrypted.salt) {
    throw new Error("No salt found - was this encrypted with a password?");
  }
  const salt = new Uint8Array(base64ToBuffer(encrypted.salt));
  const { key } = await deriveKey(password, salt);
  return decrypt(encrypted, key);
}

/**
 * Serialize encrypted data to a single string for storage
 */
export function serializeEncrypted(encrypted: EncryptedData): string {
  return JSON.stringify(encrypted);
}

/**
 * Deserialize encrypted data from storage
 */
export function deserializeEncrypted(data: string): EncryptedData {
  return JSON.parse(data);
}
