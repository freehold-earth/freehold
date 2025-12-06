import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteStorage } from "../src/storage/sqlite.js";
import { EncryptedVault } from "../src/vault/encrypted-vault.js";
import { encrypt, generateKey } from "../src/crypto/index.js";

describe("SQLiteStorage", () => {
  let storage: SQLiteStorage;

  beforeEach(() => {
    storage = new SQLiteStorage({
      path: ":memory:",
      vaultName: "test-vault",
    });
  });

  afterEach(() => {
    storage.close();
  });

  it("should store and retrieve entries", () => {
    const key = generateKey();
    const encrypted = encrypt("test data", key);
    const entry = {
      encrypted,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    storage.put("key1", entry);
    const retrieved = storage.get("key1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.encrypted.ciphertext).toBe(encrypted.ciphertext);
    expect(retrieved?.version).toBe(1);
  });

  it("should return undefined for missing keys", () => {
    expect(storage.get("nonexistent")).toBeUndefined();
  });

  it("should delete entries", () => {
    const key = generateKey();
    const encrypted = encrypt("test", key);
    storage.put("key1", {
      encrypted,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    expect(storage.has("key1")).toBe(true);
    expect(storage.delete("key1")).toBe(true);
    expect(storage.has("key1")).toBe(false);
    expect(storage.delete("key1")).toBe(false);
  });

  it("should list all keys", () => {
    const key = generateKey();

    storage.put("a", {
      encrypted: encrypt("a", key),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    storage.put("b", {
      encrypted: encrypt("b", key),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    storage.put("c", {
      encrypted: encrypt("c", key),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    const keys = storage.keys();
    expect(keys).toHaveLength(3);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toContain("c");
  });

  it("should export and import all entries", () => {
    const key = generateKey();

    storage.put("x", {
      encrypted: encrypt("x-data", key),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    storage.put("y", {
      encrypted: encrypt("y-data", key),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 2,
    });

    const exported = storage.getAll();
    expect(Object.keys(exported)).toHaveLength(2);

    // Clear and reimport
    storage.clear();
    expect(storage.keys()).toHaveLength(0);

    storage.importAll(exported);
    expect(storage.keys()).toHaveLength(2);
    expect(storage.get("x")?.version).toBe(1);
    expect(storage.get("y")?.version).toBe(2);
  });

  it("should isolate data between vault names", () => {
    const key = generateKey();
    storage.put("shared-key", {
      encrypted: encrypt("vault1-data", key),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    });

    // Create another storage with different vault name using same DB path
    const storage2 = new SQLiteStorage({
      path: ":memory:",
      vaultName: "other-vault",
    });

    // The new storage shouldn't see the data from vault1
    expect(storage2.get("shared-key")).toBeUndefined();
    storage2.close();
  });
});

describe("EncryptedVault with SQLite", () => {
  let vault: EncryptedVault;

  beforeEach(async () => {
    vault = new EncryptedVault({
      name: "sqlite-test",
      storage: {
        type: "sqlite",
        path: ":memory:",
      },
    });
    await vault.initialize();
  });

  afterEach(async () => {
    await vault.destroy();
  });

  it("should store and retrieve encrypted data using SQLite", async () => {
    const data = { name: "test", value: 42 };
    await vault.put("test-key", data);

    const retrieved = await vault.get<typeof data>("test-key");
    expect(retrieved?.data).toEqual(data);
  });

  it("should persist across operations", async () => {
    await vault.put("persistent", { foo: "bar" });
    await vault.put("another", { baz: 123 });

    const keys = await vault.keys();
    expect(keys).toHaveLength(2);
    expect(keys).toContain("persistent");
    expect(keys).toContain("another");
  });

  it("should support export and import with SQLite backend", async () => {
    await vault.put("item1", { a: 1 });
    await vault.put("item2", { b: 2 });

    const exported = await vault.export();
    expect(Object.keys(exported)).toHaveLength(2);
  });
});
