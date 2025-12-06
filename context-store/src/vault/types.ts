/**
 * Type definitions for PCI Context Store
 */

export interface ContextStoreConfig {
  /** Encryption configuration */
  encryption?: EncryptionConfig;
  /** Sync configuration */
  sync?: SyncConfig;
  /** Storage path (for persistent storage) */
  storagePath?: string;
}

export interface EncryptionConfig {
  /** Encryption algorithm (default: aes-256-gcm) */
  algorithm?: "aes-256-gcm";
  /** Key derivation function */
  kdf?: "argon2id" | "pbkdf2";
}

export interface VaultConfig {
  /** Vault name */
  name: string;
  /** Optional description */
  description?: string;
  /** Schema version */
  schemaVersion?: string;
  /** Encryption configuration */
  encryption?: EncryptionConfig;
  /** Storage configuration */
  storage?: StorageConfig;
}

export interface StorageConfig {
  /** Storage type: memory (default) or sqlite */
  type: "memory" | "sqlite";
  /** Path to SQLite database file (for sqlite storage) */
  path?: string;
}

export interface VaultData<T = unknown> {
  /** Unique identifier */
  id: string;
  /** Data payload */
  data: T;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
  /** Version for conflict resolution */
  version: number;
}

export interface SyncConfig {
  /** Sync mode */
  mode: "realtime" | "periodic" | "manual";
  /** Peer endpoints for sync */
  peers?: string[];
  /** Sync interval in milliseconds (for periodic mode) */
  intervalMs?: number;
}

export interface EmbeddingConfig {
  /** Embedding model to use */
  model?: string;
  /** Embedding dimensions */
  dimensions?: number;
}

export interface SearchResult<T = unknown> {
  /** The matched data */
  data: VaultData<T>;
  /** Similarity score (0-1) */
  score: number;
}
