/**
 * Encrypted Vault - Secure storage for a category of personal data
 *
 * All data is encrypted at rest using AES-256-GCM before storage.
 * Supports both in-memory (for testing) and SQLite (for persistence) backends.
 */

import type { VaultConfig, VaultData, StorageConfig } from "./types.js";
import {
  encrypt,
  decrypt,
  generateKey,
  deriveKey,
  clearKey,
} from "../crypto/index.js";
import { SQLiteStorage, type StoredEntry } from "../storage/sqlite.js";

/**
 * Storage backend interface
 */
interface StorageBackend {
  get(key: string): StoredEntry | undefined;
  put(key: string, entry: StoredEntry): void;
  delete(key: string): boolean;
  keys(): string[];
  has(key: string): boolean;
  getAll(): Record<string, StoredEntry>;
  importAll(entries: Record<string, StoredEntry>): void;
  clear(): void;
  close(): void;
}

/**
 * In-memory storage backend
 */
class MemoryStorage implements StorageBackend {
  private data: Map<string, StoredEntry> = new Map();

  get(key: string): StoredEntry | undefined {
    return this.data.get(key);
  }

  put(key: string, entry: StoredEntry): void {
    this.data.set(key, entry);
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  keys(): string[] {
    return Array.from(this.data.keys());
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  getAll(): Record<string, StoredEntry> {
    const result: Record<string, StoredEntry> = {};
    for (const [key, entry] of this.data.entries()) {
      result[key] = { ...entry };
    }
    return result;
  }

  importAll(entries: Record<string, StoredEntry>): void {
    for (const [key, entry] of Object.entries(entries)) {
      this.data.set(key, entry);
    }
  }

  clear(): void {
    this.data.clear();
  }

  close(): void {
    this.clear();
  }
}

export class EncryptedVault {
  private config: VaultConfig;
  private storage: StorageBackend;
  private encryptionKey: Buffer | null = null;
  private initialized = false;

  constructor(config: VaultConfig) {
    this.config = {
      schemaVersion: "1.0",
      storage: { type: "memory" },
      ...config,
    };

    // Create storage backend
    this.storage = this.createStorage(this.config.storage!);
  }

  private createStorage(storageConfig: StorageConfig): StorageBackend {
    if (storageConfig.type === "sqlite") {
      const path = storageConfig.path ?? `${this.config.name}.db`;
      return new SQLiteStorage({
        path,
        vaultName: this.config.name,
      });
    }
    return new MemoryStorage();
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
    const existing = this.storage.get(key);

    // Serialize and encrypt the data
    const plaintext = JSON.stringify(value);
    const encrypted = encrypt(plaintext, this.encryptionKey!);

    const entry: StoredEntry = {
      encrypted,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      version: (existing?.version ?? 0) + 1,
    };

    this.storage.put(key, entry);

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

    const entry = this.storage.get(key);
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
    return this.storage.delete(key);
  }

  /**
   * List all keys in the vault
   */
  async keys(): Promise<string[]> {
    this.ensureInitialized();
    return this.storage.keys();
  }

  /**
   * Check if a key exists
   */
  async has(key: string): Promise<boolean> {
    this.ensureInitialized();
    return this.storage.has(key);
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
    return this.storage.getAll();
  }

  /**
   * Import encrypted data from persistence/sync
   */
  async import(data: Record<string, StoredEntry>): Promise<void> {
    this.ensureInitialized();
    this.storage.importAll(data);
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
    this.storage.close();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.encryptionKey) {
      throw new Error("Vault not initialized. Call initialize() first.");
    }
  }
}
