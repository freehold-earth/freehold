/**
 * Synced Vault - EncryptedVault with CRDT sync support
 *
 * Combines local encrypted storage with Yjs-based CRDT sync for
 * multi-device replication without conflicts.
 */

import type { VaultConfig, VaultData, SyncConfig } from "./types.js";
import { EncryptedVault } from "./encrypted-vault.js";
import { CRDTSync, type SyncedEntry, type SyncEvent, type SyncStatus } from "../sync/crdt-sync.js";
import type { StoredEntry } from "../storage/sqlite.js";

export interface SyncedVaultConfig extends VaultConfig {
  sync?: SyncConfig;
}

/**
 * Vault with integrated CRDT sync
 *
 * All changes are automatically tracked in the CRDT layer for sync.
 * Remote changes are automatically applied to local storage.
 */
export class SyncedVault {
  private vault: EncryptedVault;
  private sync: CRDTSync;
  private config: SyncedVaultConfig;
  private syncUnsubscribe: (() => void) | null = null;

  constructor(config: SyncedVaultConfig) {
    this.config = config;
    this.vault = new EncryptedVault(config);
    this.sync = new CRDTSync(config.sync ?? { mode: "manual" });
  }

  /**
   * Initialize the vault with a random key
   */
  async initialize(): Promise<void> {
    await this.vault.initialize();
    await this.setupSync();
  }

  /**
   * Initialize the vault with a password-derived key
   */
  async initializeWithPassword(password: string): Promise<void> {
    await this.vault.initializeWithPassword(password);
    await this.setupSync();
  }

  /**
   * Initialize the vault with an existing key
   */
  async initializeWithKey(key: Buffer): Promise<void> {
    await this.vault.initializeWithKey(key);
    await this.setupSync();
  }

  /**
   * Setup sync after vault initialization
   */
  private async setupSync(): Promise<void> {
    // Load existing vault data into CRDT
    const entries = await this.vault.export();
    const syncEntries: Record<string, SyncedEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      syncEntries[key] = this.storedToSynced(entry);
    }
    this.sync.importEntries(syncEntries);

    // Listen for remote changes
    this.syncUnsubscribe = this.sync.onEntriesChange((event) => {
      // Apply remote changes to local storage
      event.changes.keys.forEach((change, key) => {
        if (change.action === "add" || change.action === "update") {
          const entry = this.sync.get(key);
          if (entry) {
            // Update local storage (bypassing vault to avoid re-encryption)
            this.applyRemoteEntry(key, entry);
          }
        } else if (change.action === "delete") {
          this.vault.delete(key);
        }
      });
    });

    // Start sync if configured
    if (this.config.sync?.mode !== "manual") {
      await this.sync.start();
    }
  }

  /**
   * Apply a remote entry to local storage
   */
  private async applyRemoteEntry(key: string, entry: SyncedEntry): Promise<void> {
    // Import directly to storage (already encrypted)
    const stored = this.syncedToStored(entry);
    await this.vault.import({ [key]: stored });
  }

  /**
   * Convert StoredEntry to SyncedEntry format
   */
  private storedToSynced(entry: StoredEntry): SyncedEntry {
    return {
      encrypted: entry.encrypted,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      version: entry.version,
    };
  }

  /**
   * Convert SyncedEntry to StoredEntry format
   */
  private syncedToStored(entry: SyncedEntry): StoredEntry {
    return {
      encrypted: entry.encrypted,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      version: entry.version,
    };
  }

  /**
   * Store data in the vault (encrypted + synced)
   */
  async put<T>(key: string, value: T): Promise<VaultData<T>> {
    const result = await this.vault.put(key, value);

    // Update CRDT with the encrypted entry
    const entries = await this.vault.export();
    const stored = entries[key];
    if (stored) {
      this.sync.set(key, this.storedToSynced(stored));
    }

    return result;
  }

  /**
   * Retrieve and decrypt data from the vault
   */
  async get<T>(key: string): Promise<VaultData<T> | undefined> {
    return this.vault.get<T>(key);
  }

  /**
   * Delete data from the vault (synced)
   */
  async delete(key: string): Promise<boolean> {
    const result = await this.vault.delete(key);
    if (result) {
      this.sync.remove(key);
    }
    return result;
  }

  /**
   * List all keys in the vault
   */
  async keys(): Promise<string[]> {
    return this.vault.keys();
  }

  /**
   * Check if a key exists
   */
  async has(key: string): Promise<boolean> {
    return this.vault.has(key);
  }

  /**
   * Get vault configuration
   */
  getConfig(): SyncedVaultConfig {
    return { ...this.config };
  }

  /**
   * Start the sync engine (if not already running)
   */
  async startSync(): Promise<void> {
    await this.sync.start();
  }

  /**
   * Stop the sync engine
   */
  async stopSync(): Promise<void> {
    await this.sync.stop();
  }

  /**
   * Trigger a manual sync
   */
  async syncNow(): Promise<Uint8Array> {
    return this.sync.syncNow();
  }

  /**
   * Get the current sync status
   */
  getSyncStatus(): SyncStatus {
    return this.sync.getStatus();
  }

  /**
   * Subscribe to sync events
   */
  onSyncEvent(listener: (event: SyncEvent) => void): () => void {
    return this.sync.onEvent(listener);
  }

  /**
   * Get sync updates since a state vector (for manual sync)
   */
  getUpdatesSince(stateVector: Uint8Array): Uint8Array {
    return this.sync.getUpdatesSince(stateVector);
  }

  /**
   * Apply a sync update from another peer
   */
  applyUpdate(update: Uint8Array, origin?: unknown): void {
    this.sync.applyUpdate(update, origin);
  }

  /**
   * Get the current state vector (for sync negotiation)
   */
  getStateVector(): Uint8Array {
    return this.sync.getStateVector();
  }

  /**
   * Add a peer for syncing
   */
  async addPeer(endpoint: string): Promise<void> {
    await this.sync.addPeer(endpoint);
  }

  /**
   * Remove a peer
   */
  async removePeer(endpoint: string): Promise<void> {
    await this.sync.removePeer(endpoint);
  }

  /**
   * Get the underlying CRDT sync engine (for advanced use)
   */
  getCRDTSync(): CRDTSync {
    return this.sync;
  }

  /**
   * Destroy the vault and cleanup resources
   */
  async destroy(): Promise<void> {
    if (this.syncUnsubscribe) {
      this.syncUnsubscribe();
      this.syncUnsubscribe = null;
    }
    this.sync.destroy();
    await this.vault.destroy();
  }
}
