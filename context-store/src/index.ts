/**
 * PCI Context Store
 *
 * Layer 1: Encrypted local-first data storage with CRDT sync
 */

export { ContextStore } from "./vault/context-store.js";
export { EncryptedVault } from "./vault/encrypted-vault.js";
export { CRDTSync } from "./sync/crdt-sync.js";
export { VectorStore } from "./embeddings/vector-store.js";

// Types
export type {
  ContextStoreConfig,
  VaultConfig,
  VaultData,
  SyncConfig,
  EmbeddingConfig,
} from "./vault/types.js";
