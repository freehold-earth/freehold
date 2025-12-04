import { describe, it, expect, beforeEach } from "vitest";
import { ContextStore } from "../src/vault/context-store.js";

describe("ContextStore", () => {
  let store: ContextStore;

  beforeEach(() => {
    store = new ContextStore();
  });

  describe("vault management", () => {
    it("should create a new vault", async () => {
      const vault = await store.createVault("test");
      expect(vault).toBeDefined();
      expect(vault.getConfig().name).toBe("test");
    });

    it("should not allow duplicate vault names", async () => {
      await store.createVault("test");
      await expect(store.createVault("test")).rejects.toThrow('Vault "test" already exists');
    });

    it("should list all vaults", async () => {
      await store.createVault("health");
      await store.createVault("financial");

      const vaults = store.listVaults();
      expect(vaults).toContain("health");
      expect(vaults).toContain("financial");
    });

    it("should get vault by name", async () => {
      await store.createVault("health");

      const vault = store.getVault("health");
      expect(vault).toBeDefined();
      expect(store.getVault("nonexistent")).toBeUndefined();
    });

    it("should delete a vault", async () => {
      await store.createVault("temporary");

      expect(await store.deleteVault("temporary")).toBe(true);
      expect(store.getVault("temporary")).toBeUndefined();
      expect(await store.deleteVault("temporary")).toBe(false);
    });
  });
});

describe("EncryptedVault", () => {
  let store: ContextStore;

  beforeEach(async () => {
    store = new ContextStore();
  });

  describe("data operations", () => {
    it("should store and retrieve data", async () => {
      const vault = await store.createVault("test");

      const entry = await vault.put("key1", { value: "test data" });
      expect(entry.id).toBe("key1");
      expect(entry.data).toEqual({ value: "test data" });

      const retrieved = await vault.get("key1");
      expect(retrieved?.data).toEqual({ value: "test data" });
    });

    it("should update existing data", async () => {
      const vault = await store.createVault("test");

      await vault.put("key1", { value: "original" });
      const updated = await vault.put("key1", { value: "updated" });

      expect(updated.version).toBe(2);
      expect(updated.data).toEqual({ value: "updated" });
    });

    it("should delete data", async () => {
      const vault = await store.createVault("test");

      await vault.put("key1", { value: "test" });
      expect(await vault.has("key1")).toBe(true);

      expect(await vault.delete("key1")).toBe(true);
      expect(await vault.has("key1")).toBe(false);
    });

    it("should list all keys", async () => {
      const vault = await store.createVault("test");

      await vault.put("key1", { value: 1 });
      await vault.put("key2", { value: 2 });
      await vault.put("key3", { value: 3 });

      const keys = await vault.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
      expect(keys).toContain("key3");
    });
  });
});
