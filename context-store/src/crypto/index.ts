/**
 * Cryptographic utilities for PCI Context Store
 *
 * Implements AES-256-GCM encryption with PBKDF2 key derivation.
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

export interface EncryptedData {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded authentication tag */
  authTag: string;
  /** Base64-encoded salt (if key was derived from password) */
  salt?: string;
}

export interface DerivedKey {
  /** The derived key bytes */
  key: Buffer;
  /** The salt used for derivation */
  salt: Buffer;
}

/**
 * Derive an encryption key from a password using PBKDF2
 */
export function deriveKey(password: string, salt?: Buffer): DerivedKey {
  const actualSalt = salt ?? randomBytes(SALT_LENGTH);
  const key = pbkdf2Sync(password, actualSalt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
  return { key, salt: actualSalt };
}

/**
 * Generate a random encryption key
 */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Encrypt data using AES-256-GCM
 *
 * @param plaintext - The data to encrypt (string or buffer)
 * @param key - 32-byte encryption key
 * @returns Encrypted data with IV and auth tag
 */
export function encrypt(plaintext: string | Buffer, key: Buffer): EncryptedData {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes (got ${key.length})`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypt data using AES-256-GCM
 *
 * @param encrypted - The encrypted data with IV and auth tag
 * @param key - 32-byte encryption key
 * @returns Decrypted plaintext as string
 * @throws Error if decryption fails (wrong key or tampered data)
 */
export function decrypt(encrypted: EncryptedData, key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes (got ${key.length})`);
  }

  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    throw new Error("Decryption failed: invalid key or tampered data");
  }
}

/**
 * Encrypt data with a password (derives key automatically)
 */
export function encryptWithPassword(plaintext: string | Buffer, password: string): EncryptedData {
  const { key, salt } = deriveKey(password);
  const result = encrypt(plaintext, key);
  result.salt = salt.toString("base64");
  return result;
}

/**
 * Decrypt data with a password (derives key from stored salt)
 */
export function decryptWithPassword(encrypted: EncryptedData, password: string): string {
  if (!encrypted.salt) {
    throw new Error("No salt found in encrypted data - was this encrypted with a password?");
  }
  const salt = Buffer.from(encrypted.salt, "base64");
  const { key } = deriveKey(password, salt);
  return decrypt(encrypted, key);
}

/**
 * Securely clear a buffer from memory
 */
export function clearKey(key: Buffer): void {
  key.fill(0);
}
