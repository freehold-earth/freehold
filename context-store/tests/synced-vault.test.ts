/**
 * Tests for SyncedVault - EncryptedVault with CRDT sync
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SyncedVault } from "../src/vault/synced-vault.js";
import type { SyncEvent } from "../src/sync/crdt-sync.js";

describe("SyncedVault", () => {
  let vault: SyncedVault;

  beforeEach(async () => {
    vault = new SyncedVault({
      name: "test-synced-vault",
      storage: { type: "memory" },
      sync: { mode: "manual" },
    });
    await vault.initialize();
  });

  afterEach(async () => {
    await vault.destroy();
  });

  describe("basic vault operations", () => {
    it("should store and retrieve data", async () => {
      await vault.put("test-key", { message: "hello world" });
      const result = await vault.get<{ message: string }>("test-key");

      expect(result?.data.message).toBe("hello world");
    });

    it("should check if key exists", async () => {
      expect(await vault.has("missing")).toBe(false);

      await vault.put("exists", { value: 1 });
      expect(await vault.has("exists")).toBe(true);
    });

    it("should list all keys", async () => {
      await vault.put("key1", { a: 1 });
      await vault.put("key2", { b: 2 });

      const keys = await vault.keys();
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
    });

    it("should delete entries", async () => {
      await vault.put("to-delete", { value: "bye" });
      expect(await vault.has("to-delete")).toBe(true);

      const deleted = await vault.delete("to-delete");
      expect(deleted).toBe(true);
      expect(await vault.has("to-delete")).toBe(false);
    });
  });

  describe("initialization methods", () => {
    it("should initialize with password", async () => {
      const passwordVault = new SyncedVault({
        name: "password-vault",
        storage: { type: "memory" },
        sync: { mode: "manual" },
      });

      await passwordVault.initializeWithPassword("test-password-123");

      await passwordVault.put("secret", { data: "encrypted-with-password" });
      const result = await passwordVault.get<{ data: string }>("secret");
      expect(result?.data.data).toBe("encrypted-with-password");

      await passwordVault.destroy();
    });

    it("should initialize with key", async () => {
      const key = Buffer.alloc(32, "a"); // 32 bytes for AES-256

      const keyVault = new SyncedVault({
        name: "key-vault",
        storage: { type: "memory" },
        sync: { mode: "manual" },
      });

      await keyVault.initializeWithKey(key);

      await keyVault.put("data", { value: 42 });
      const result = await keyVault.get<{ value: number }>("data");
      expect(result?.data.value).toBe(42);

      await keyVault.destroy();
    });
  });

  describe("sync operations", () => {
    it("should sync between two vaults", async () => {
      const vault1 = new SyncedVault({
        name: "vault1",
        storage: { type: "memory" },
        sync: { mode: "manual" },
      });
      const vault2 = new SyncedVault({
        name: "vault2",
        storage: { type: "memory" },
        sync: { mode: "manual" },
      });

      // Use same key for both vaults
      const sharedKey = Buffer.alloc(32, "shared-key");
      await vault1.initializeWithKey(sharedKey);
      await vault2.initializeWithKey(sharedKey);

      // Add data to vault1
      await vault1.put("from-vault1", { origin: "vault1" });

      // Sync vault1 -> vault2
      const update = vault1.getUpdatesSince(vault2.getStateVector());
      vault2.applyUpdate(update);

      // vault2 should now have the data
      const result = await vault2.get<{ origin: string }>("from-vault1");
      expect(result?.data.origin).toBe("vault1");

      await vault1.destroy();
      await vault2.destroy();
    });

    it("should handle bidirectional sync", async () => {
      const vault1 = new SyncedVault({
        name: "vault1",
        storage: { type: "memory" },
        sync: { mode: "manual" },
      });
      const vault2 = new SyncedVault({
        name: "vault2",
        storage: { type: "memory" },
        sync: { mode: "manual" },
      });

      const sharedKey = Buffer.alloc(32, "shared-key");
      await vault1.initializeWithKey(sharedKey);
      await vault2.initializeWithKey(sharedKey);

      // Add data to both vaults
      await vault1.put("from-v1", { source: 1 });
      await vault2.put("from-v2", { source: 2 });

      // Exchange updates
      const update1 = vault1.getUpdatesSince(vault2.getStateVector());
      const update2 = vault2.getUpdatesSince(vault1.getStateVector());

      vault2.applyUpdate(update1);
      vault1.applyUpdate(update2);

      // Both should have both entries
      expect(await vault1.has("from-v1")).toBe(true);
      expect(await vault1.has("from-v2")).toBe(true);
      expect(await vault2.has("from-v1")).toBe(true);
      expect(await vault2.has("from-v2")).toBe(true);

      await vault1.destroy();
      await vault2.destroy();
    });

    it("should track sync status", async () => {
      expect(vault.getSyncStatus()).toBe("idle");

      await vault.syncNow();
      expect(vault.getSyncStatus()).toBe("idle"); // Returns to idle after manual sync
    });

    it("should emit sync events", async () => {
      const events: SyncEvent[] = [];
      vault.onSyncEvent((event) => events.push(event));

      await vault.startSync();

      expect(events.some((e) => e.type === "sync_start")).toBe(true);
    });

    it("should return state update on syncNow", async () => {
      await vault.put("test", { value: 123 });

      const update = await vault.syncNow();
      expect(update).toBeInstanceOf(Uint8Array);
      expect(update.length).toBeGreaterThan(0);
    });
  });

  describe("config", () => {
    it("should return vault configuration", () => {
      const config = vault.getConfig();
      expect(config.name).toBe("test-synced-vault");
      expect(config.sync?.mode).toBe("manual");
    });
  });

  describe("CRDT access", () => {
    it("should expose underlying CRDT sync engine", () => {
      const crdt = vault.getCRDTSync();
      expect(crdt).toBeDefined();
      expect(typeof crdt.getStateVector).toBe("function");
    });
  });
});
