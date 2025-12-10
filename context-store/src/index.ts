/**
 * PCI Context Store
 *
 * Layer 1: Encrypted local-first data storage with CRDT sync
 */

export { ContextStore } from "./vault/context-store.js";
export { EncryptedVault } from "./vault/encrypted-vault.js";
export { SyncedVault } from "./vault/synced-vault.js";
export { CRDTSync } from "./sync/crdt-sync.js";
export type { SyncedEntry, SyncedData, SyncEvent, SyncStatus } from "./sync/crdt-sync.js";
export type { SyncedVaultConfig } from "./vault/synced-vault.js";
export { VectorStore } from "./embeddings/vector-store.js";
export { SQLiteVectorStore } from "./vectors/index.js";
export type { VectorSearchResult, VectorStoreOptions } from "./vectors/index.js";

// Crypto utilities
export {
  encrypt,
  decrypt,
  encryptWithPassword,
  decryptWithPassword,
  generateKey,
  deriveKey,
  clearKey,
} from "./crypto/index.js";

// Storage
export { SQLiteStorage } from "./storage/sqlite.js";
export type { StoredEntry, SQLiteStorageOptions } from "./storage/sqlite.js";

// Types
export type {
  ContextStoreConfig,
  VaultConfig,
  VaultData,
  SyncConfig,
  EmbeddingConfig,
  StorageConfig,
} from "./vault/types.js";

export type { EncryptedData, DerivedKey } from "./crypto/index.js";
