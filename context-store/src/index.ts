/**
 * PCI Context Store
 *
 * Layer 1: Encrypted local-first data storage with CRDT sync
 */

export type { DerivedKey, EncryptedData } from "./crypto/index.js"
// Crypto utilities
export {
  clearKey,
  decrypt,
  decryptWithPassword,
  deriveKey,
  encrypt,
  encryptWithPassword,
  generateKey,
} from "./crypto/index.js"
export { VectorStore } from "./embeddings/vector-store.js"
export type { SQLiteStorageOptions, StoredEntry } from "./storage/sqlite.js"
// Storage
export { SQLiteStorage } from "./storage/sqlite.js"
export type {
  SyncEvent,
  SyncedData,
  SyncedEntry,
  SyncStatus,
} from "./sync/crdt-sync.js"
export { CRDTSync } from "./sync/crdt-sync.js"
export { ContextStore } from "./vault/context-store.js"
export { EncryptedVault } from "./vault/encrypted-vault.js"
export type { SyncedVaultConfig } from "./vault/synced-vault.js"
export { SyncedVault } from "./vault/synced-vault.js"
// Types
export type {
  ContextStoreConfig,
  EmbeddingConfig,
  StorageConfig,
  SyncConfig,
  VaultConfig,
  VaultData,
} from "./vault/types.js"
export type { VectorSearchResult, VectorStoreOptions } from "./vectors/index.js"
export { SQLiteVectorStore } from "./vectors/index.js"
