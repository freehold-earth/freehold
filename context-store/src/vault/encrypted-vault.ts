/**
 * Encrypted Vault - Secure storage for a category of personal data
 *
 * All data is encrypted at rest using AES-256-GCM before storage.
 */

import type { VaultConfig, VaultData } from "./types.js";
import {
  encrypt,
  decrypt,
  generateKey,
  deriveKey,
  clearKey,
  type EncryptedData,
} from "../crypto/index.js";

interface StoredEntry {
  encrypted: EncryptedData;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export class EncryptedVault {
  private config: VaultConfig;
  private data: Map<string, StoredEntry> = new Map();
  private encryptionKey: Buffer | null = null;
  private initialized = false;

  constructor(config: VaultConfig) {
    this.config = {
      schemaVersion: "1.0",
      ...config,
    };
  }

  /**
   * Initialize the vault with a random key
   */
  async initialize(): Promise<void> {
    this.encryptionKey = generateKey();
    this.initialized = true;
  }

  /**
   * Initialize the vault with a password-derived key
   */
  async initializeWithPassword(password: string): Promise<void> {
    const { key } = deriveKey(password);
    this.encryptionKey = key;
    this.initialized = true;
  }

  /**
   * Initialize the vault with an existing key
   */
  async initializeWithKey(key: Buffer): Promise<void> {
    if (key.length !== 32) {
      throw new Error("Key must be 32 bytes (256 bits)");
    }
    this.encryptionKey = Buffer.from(key); // Copy to avoid external mutation
    this.initialized = true;
  }

  /**
   * Store data in the vault (encrypted)
   */
  async put<T>(key: string, value: T): Promise<VaultData<T>> {
    this.ensureInitialized();

    const now = new Date();
    const existing = this.data.get(key);

    // Serialize and encrypt the data
    const plaintext = JSON.stringify(value);
    const encrypted = encrypt(plaintext, this.encryptionKey!);

    const entry: StoredEntry = {
      encrypted,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      version: (existing?.version ?? 0) + 1,
    };

    this.data.set(key, entry);

    return {
      id: key,
      data: value,
      createdAt: existing?.createdAt ? new Date(existing.createdAt) : now,
      updatedAt: now,
      version: entry.version,
    };
  }

  /**
   * Retrieve and decrypt data from the vault
   */
  async get<T>(key: string): Promise<VaultData<T> | undefined> {
    this.ensureInitialized();

    const entry = this.data.get(key);
    if (!entry) {
      return undefined;
    }

    // Decrypt and deserialize
    const plaintext = decrypt(entry.encrypted, this.encryptionKey!);
    const data = JSON.parse(plaintext) as T;

    return {
      id: key,
      data,
      createdAt: new Date(entry.createdAt),
      updatedAt: new Date(entry.updatedAt),
      version: entry.version,
    };
  }

  /**
   * Delete data from the vault
   */
  async delete(key: string): Promise<boolean> {
    this.ensureInitialized();
    return this.data.delete(key);
  }

  /**
   * List all keys in the vault
   */
  async keys(): Promise<string[]> {
    this.ensureInitialized();
    return Array.from(this.data.keys());
  }

  /**
   * Check if a key exists
   */
  async has(key: string): Promise<boolean> {
    this.ensureInitialized();
    return this.data.has(key);
  }

  /**
   * Get vault metadata
   */
  getConfig(): VaultConfig {
    return { ...this.config };
  }

  /**
   * Export encrypted data for persistence/sync
   */
  async export(): Promise<Record<string, StoredEntry>> {
    this.ensureInitialized();
    const result: Record<string, StoredEntry> = {};
    for (const [key, entry] of this.data.entries()) {
      result[key] = { ...entry };
    }
    return result;
  }

  /**
   * Import encrypted data from persistence/sync
   */
  async import(data: Record<string, StoredEntry>): Promise<void> {
    this.ensureInitialized();
    for (const [key, entry] of Object.entries(data)) {
      this.data.set(key, entry);
    }
  }

  /**
   * Destroy the vault and cleanup resources
   */
  async destroy(): Promise<void> {
    // Securely clear the encryption key from memory
    if (this.encryptionKey) {
      clearKey(this.encryptionKey);
      this.encryptionKey = null;
    }
    this.data.clear();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.encryptionKey) {
      throw new Error("Vault not initialized. Call initialize() first.");
    }
  }
}
