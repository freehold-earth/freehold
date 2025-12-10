/**
 * CRDT Sync Engine - Conflict-free replication across devices using Yjs
 *
 * Yjs provides:
 * - Automatic conflict resolution via CRDTs
 * - Offline-first with sync when connected
 * - Multiple provider support (WebSocket, WebRTC, etc.)
 */

import * as Y from "yjs";
import type { SyncConfig } from "../vault/types.js";
import type { EncryptedData } from "../crypto/index.js";

export type SyncStatus = "idle" | "connecting" | "syncing" | "connected" | "error";

export interface SyncEvent {
  type: "sync_start" | "sync_complete" | "sync_error" | "connected" | "disconnected" | "update";
  timestamp: Date;
  details?: unknown;
}

export interface SyncedEntry {
  encrypted: EncryptedData;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** @deprecated Use SyncedEntry instead */
export type SyncedData = SyncedEntry;

/**
 * Yjs-based CRDT Sync Engine
 *
 * Each vault gets a Y.Doc that tracks all changes. The Y.Doc can be synced
 * across devices using y-websocket (self-hosted) or other providers.
 */
export class CRDTSync {
  private config: SyncConfig;
  private status: SyncStatus = "idle";
  private listeners: Set<(event: SyncEvent) => void> = new Set();

  /** The Yjs document - the core CRDT container */
  private doc: Y.Doc;

  /** Map of vault entries - synced across all peers */
  private entries: Y.Map<SyncedEntry>;

  /** WebSocket provider for network sync (lazy loaded) */
  private wsProvider: unknown | null = null;

  /** Periodic sync interval handle */
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: SyncConfig) {
    this.config = config;

    // Initialize Yjs document
    this.doc = new Y.Doc();

    // Create a shared map for vault entries
    this.entries = this.doc.getMap<SyncedEntry>("entries");

    // Listen for remote updates
    this.doc.on("update", (_update: Uint8Array, origin: unknown) => {
      // Only emit for remote updates (not our own changes)
      if (origin !== this) {
        this.emit({ type: "update", timestamp: new Date() });
      }
    });
  }

  /**
   * Get the underlying Y.Doc for direct access
   */
  getDoc(): Y.Doc {
    return this.doc;
  }

  /**
   * Get the entries map for direct CRDT operations
   */
  getEntries(): Y.Map<SyncedEntry> {
    return this.entries;
  }

  /**
   * Set an entry (CRDT operation - automatically synced)
   */
  set(key: string, data: SyncedEntry): void {
    this.doc.transact(() => {
      this.entries.set(key, data);
    }, this); // 'this' as origin to identify local changes
  }

  /**
   * Get an entry
   */
  get(key: string): SyncedEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * Delete an entry (CRDT operation - automatically synced)
   */
  remove(key: string): boolean {
    const existed = this.entries.has(key);
    if (existed) {
      this.doc.transact(() => {
        this.entries.delete(key);
      }, this);
    }
    return existed;
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Check if key exists
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Get all entries as a plain object
   */
  toJSON(): Record<string, SyncedEntry> {
    return this.entries.toJSON() as Record<string, SyncedEntry>;
  }

  /**
   * Import entries from a plain object (for initial load)
   */
  importEntries(data: Record<string, SyncedEntry>): void {
    this.doc.transact(() => {
      for (const [key, value] of Object.entries(data)) {
        this.entries.set(key, value);
      }
    }, this);
  }

  /**
   * Start the sync engine
   */
  async start(): Promise<void> {
    if (this.config.mode === "realtime" && this.config.peers?.length) {
      await this.connectToPeers();
    }

    if (this.config.mode === "periodic" && this.config.intervalMs) {
      this.syncInterval = setInterval(() => {
        this.syncNow().catch((err) => {
          this.emit({ type: "sync_error", timestamp: new Date(), details: err });
        });
      }, this.config.intervalMs);
    }

    this.emit({ type: "sync_start", timestamp: new Date() });
  }

  /**
   * Connect to WebSocket peers for realtime sync
   */
  private async connectToPeers(): Promise<void> {
    if (!this.config.peers?.length) return;

    this.status = "connecting";

    // Dynamic import to avoid issues in non-browser environments
    try {
      const { WebsocketProvider } = await import("y-websocket");

      // Connect to first peer (could extend to multiple)
      const serverUrl = this.config.peers[0];
      const roomName = "pci-vault"; // Could be configurable per vault

      this.wsProvider = new WebsocketProvider(serverUrl, roomName, this.doc);

      // Type assertion for event handling
      const provider = this.wsProvider as {
        on: (event: string, callback: () => void) => void;
        destroy: () => void;
        wsconnected: boolean;
      };

      provider.on("sync", () => {
        this.status = "connected";
        this.emit({ type: "connected", timestamp: new Date() });
      });

      provider.on("connection-close", () => {
        this.status = "idle";
        this.emit({ type: "disconnected", timestamp: new Date() });
      });

      provider.on("connection-error", () => {
        this.status = "error";
        this.emit({ type: "sync_error", timestamp: new Date(), details: "Connection error" });
      });
    } catch (err) {
      this.status = "error";
      this.emit({ type: "sync_error", timestamp: new Date(), details: err });
      throw err;
    }
  }

  /**
   * Stop the sync engine
   */
  async stop(): Promise<void> {
    // Stop periodic sync
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    // Disconnect WebSocket provider
    if (this.wsProvider) {
      const provider = this.wsProvider as { destroy: () => void };
      provider.destroy();
      this.wsProvider = null;
    }

    this.status = "idle";
    this.emit({ type: "disconnected", timestamp: new Date() });
  }

  /**
   * Trigger a manual sync (exports current state)
   */
  async syncNow(): Promise<Uint8Array> {
    if (this.status === "syncing") {
      return Y.encodeStateAsUpdate(this.doc);
    }

    this.status = "syncing";
    this.emit({ type: "sync_start", timestamp: new Date() });

    try {
      // Get the current state as an update
      const update = Y.encodeStateAsUpdate(this.doc);
      this.emit({ type: "sync_complete", timestamp: new Date() });
      return update;
    } catch (error) {
      this.emit({ type: "sync_error", timestamp: new Date(), details: error });
      throw error;
    } finally {
      this.status = this.wsProvider ? "connected" : "idle";
    }
  }

  /**
   * Apply an update from another peer
   */
  applyUpdate(update: Uint8Array, origin?: unknown): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  /**
   * Get the full state vector for sync negotiation
   */
  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * Get updates since a given state vector
   */
  getUpdatesSince(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Add a peer for syncing
   */
  async addPeer(endpoint: string): Promise<void> {
    this.config.peers = [...(this.config.peers ?? []), endpoint];

    // If in realtime mode and running, connect to new peer
    if (this.config.mode === "realtime" && !this.wsProvider) {
      await this.connectToPeers();
    }
  }

  /**
   * Remove a peer
   */
  async removePeer(endpoint: string): Promise<void> {
    this.config.peers = this.config.peers?.filter((p) => p !== endpoint);

    // If no peers left, disconnect
    if (!this.config.peers?.length && this.wsProvider) {
      const provider = this.wsProvider as { destroy: () => void };
      provider.destroy();
      this.wsProvider = null;
      this.status = "idle";
    }
  }

  /**
   * Subscribe to sync events
   */
  onEvent(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to entry changes
   */
  onEntriesChange(callback: (event: Y.YMapEvent<SyncedEntry>) => void): () => void {
    this.entries.observe(callback);
    return () => this.entries.unobserve(callback);
  }

  /**
   * Destroy the sync engine and cleanup
   */
  destroy(): void {
    this.stop();
    this.doc.destroy();
    this.listeners.clear();
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
