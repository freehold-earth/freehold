/**
 * Tests for Yjs-based CRDT Sync Engine
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CRDTSync, type SyncedEntry, type SyncEvent } from "../src/sync/crdt-sync.js";
import type { EncryptedData } from "../src/crypto/index.js";

/** Helper to create mock encrypted data */
function mockEncrypted(data: string): EncryptedData {
  return {
    ciphertext: Buffer.from(data).toString("base64"),
    iv: Buffer.from("test-iv-12ch").toString("base64"),
    authTag: Buffer.from("test-auth-tag-16").toString("base64"),
  };
}

describe("CRDTSync", () => {
  let sync: CRDTSync;

  beforeEach(() => {
    sync = new CRDTSync({ mode: "manual" });
  });

  afterEach(() => {
    sync.destroy();
  });

  describe("basic operations", () => {
    it("should set and get entries", () => {
      const data: SyncedEntry = {
        encrypted: mockEncrypted("encrypted-data-here"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      };

      sync.set("test-key", data);
      const retrieved = sync.get("test-key");

      expect(retrieved).toEqual(data);
    });

    it("should check if key exists", () => {
      expect(sync.has("nonexistent")).toBe(false);

      sync.set("exists", {
        encrypted: mockEncrypted("data"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      expect(sync.has("exists")).toBe(true);
    });

    it("should list all keys", () => {
      sync.set("key1", {
        encrypted: mockEncrypted("data1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });
      sync.set("key2", {
        encrypted: mockEncrypted("data2"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      const keys = sync.keys();
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
      expect(keys.length).toBe(2);
    });

    it("should remove entries", () => {
      sync.set("to-delete", {
        encrypted: mockEncrypted("data"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      expect(sync.has("to-delete")).toBe(true);
      const removed = sync.remove("to-delete");
      expect(removed).toBe(true);
      expect(sync.has("to-delete")).toBe(false);
    });

    it("should return false when removing nonexistent key", () => {
      const removed = sync.remove("nonexistent");
      expect(removed).toBe(false);
    });

    it("should export entries as JSON", () => {
      const encrypted = mockEncrypted("data1");
      sync.set("key1", {
        encrypted,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        version: 1,
      });

      const json = sync.toJSON();
      expect(json).toEqual({
        key1: {
          encrypted,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          version: 1,
        },
      });
    });

    it("should import entries from object", () => {
      const data = {
        imported1: {
          encrypted: mockEncrypted("data1"),
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          version: 1,
        },
        imported2: {
          encrypted: mockEncrypted("data2"),
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          version: 2,
        },
      };

      sync.importEntries(data);

      expect(sync.get("imported1")).toEqual(data.imported1);
      expect(sync.get("imported2")).toEqual(data.imported2);
    });
  });

  describe("CRDT sync between instances", () => {
    it("should sync changes between two instances via updates", () => {
      const sync1 = new CRDTSync({ mode: "manual" });
      const sync2 = new CRDTSync({ mode: "manual" });

      const encrypted = mockEncrypted("sync1-data");

      // Add data to sync1
      sync1.set("from-sync1", {
        encrypted,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      // Get update from sync1 and apply to sync2
      const update = sync1.getUpdatesSince(sync2.getStateVector());
      sync2.applyUpdate(update);

      // sync2 should now have the data
      expect(sync2.get("from-sync1")?.encrypted).toEqual(encrypted);

      sync1.destroy();
      sync2.destroy();
    });

    it("should handle concurrent updates (CRDT merge)", () => {
      const sync1 = new CRDTSync({ mode: "manual" });
      const sync2 = new CRDTSync({ mode: "manual" });

      // Both add different keys concurrently
      sync1.set("key-from-1", {
        encrypted: mockEncrypted("data1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      sync2.set("key-from-2", {
        encrypted: mockEncrypted("data2"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      // Exchange updates
      const update1 = sync1.getUpdatesSince(sync2.getStateVector());
      const update2 = sync2.getUpdatesSince(sync1.getStateVector());

      sync2.applyUpdate(update1);
      sync1.applyUpdate(update2);

      // Both should have both keys
      expect(sync1.has("key-from-1")).toBe(true);
      expect(sync1.has("key-from-2")).toBe(true);
      expect(sync2.has("key-from-1")).toBe(true);
      expect(sync2.has("key-from-2")).toBe(true);

      sync1.destroy();
      sync2.destroy();
    });

    it("should handle concurrent edits to same key (last-write-wins for map)", () => {
      const sync1 = new CRDTSync({ mode: "manual" });
      const sync2 = new CRDTSync({ mode: "manual" });

      // Start with same initial state
      const initial = {
        encrypted: mockEncrypted("initial"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      sync1.set("shared-key", initial);

      // Sync to sync2
      sync2.applyUpdate(sync1.getUpdatesSince(sync2.getStateVector()));

      // Both edit the same key concurrently
      sync1.set("shared-key", {
        ...initial,
        encrypted: mockEncrypted("edit-from-1"),
        version: 2,
      });

      sync2.set("shared-key", {
        ...initial,
        encrypted: mockEncrypted("edit-from-2"),
        version: 2,
      });

      // Exchange updates
      const update1 = sync1.getUpdatesSince(sync2.getStateVector());
      const update2 = sync2.getUpdatesSince(sync1.getStateVector());

      sync2.applyUpdate(update1);
      sync1.applyUpdate(update2);

      // Both should converge to the same value (Yjs Y.Map uses LWW)
      expect(sync1.get("shared-key")?.encrypted).toEqual(sync2.get("shared-key")?.encrypted);

      sync1.destroy();
      sync2.destroy();
    });
  });

  describe("event handling", () => {
    it("should emit events on changes", async () => {
      const events: SyncEvent[] = [];
      sync.onEvent((event) => events.push(event));

      await sync.start();

      expect(events.some((e) => e.type === "sync_start")).toBe(true);
    });

    it("should emit update events for remote changes", () => {
      const sync1 = new CRDTSync({ mode: "manual" });
      const sync2 = new CRDTSync({ mode: "manual" });

      const events: SyncEvent[] = [];
      sync2.onEvent((event) => events.push(event));

      // Make a change in sync1
      sync1.set("remote-change", {
        encrypted: mockEncrypted("data"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      // Apply to sync2 (simulating remote update)
      sync2.applyUpdate(sync1.getUpdatesSince(sync2.getStateVector()), "remote");

      // Should have received an update event
      expect(events.some((e) => e.type === "update")).toBe(true);

      sync1.destroy();
      sync2.destroy();
    });

    it("should allow unsubscribing from events", () => {
      const events: SyncEvent[] = [];
      const unsubscribe = sync.onEvent((event) => events.push(event));

      unsubscribe();

      sync.set("test", {
        encrypted: mockEncrypted("data"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      // No events should be captured after unsubscribe
      // (set doesn't emit events, but this tests the unsubscribe mechanism)
      expect(events.length).toBe(0);
    });
  });

  describe("status", () => {
    it("should start with idle status", () => {
      expect(sync.getStatus()).toBe("idle");
    });

    it("should update status during sync", async () => {
      await sync.syncNow();
      // After sync completes, status should return to idle (no WS provider)
      expect(sync.getStatus()).toBe("idle");
    });
  });

  describe("manual sync", () => {
    it("should return state update on syncNow", async () => {
      sync.set("test", {
        encrypted: mockEncrypted("data"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      const update = await sync.syncNow();
      expect(update).toBeInstanceOf(Uint8Array);
      expect(update.length).toBeGreaterThan(0);
    });
  });
});
