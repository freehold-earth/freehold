import { describe, expect, it } from "vitest";
import { deleteProfile, loadProfile, type ProfileStore, saveProfile } from "../src/profile";

class FakeStore implements ProfileStore {
  entries = new Map<string, unknown>();
  async get<T>(key: string): Promise<{ data: T } | null> {
    return this.entries.has(key) ? { data: this.entries.get(key) as T } : null;
  }
  async put<T>(key: string, data: T): Promise<unknown> {
    this.entries.set(key, data);
    return { key };
  }
  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }
}

describe("the profile is kept one entry per scope", () => {
  it("writes the birth date under personal/age and the name under personal/name", async () => {
    const store = new FakeStore();
    await saveProfile(store, { birthDate: "1990-05-15", fullName: "Alice Demo" });
    expect([...store.entries.keys()].sort()).toEqual(["personal/age", "personal/name"]);
    expect(store.entries.get("personal/age")).toEqual({ birthDate: "1990-05-15" });
    expect(store.entries.get("personal/name")).toEqual({ fullName: "Alice Demo" });
  });

  it("loads the profile from the two entries and reports none when neither exists", async () => {
    const store = new FakeStore();
    expect(await loadProfile(store)).toBeNull();
    await saveProfile(store, { birthDate: "1990-05-15", fullName: "Alice Demo" });
    expect(await loadProfile(store)).toEqual({ birthDate: "1990-05-15", fullName: "Alice Demo" });
  });

  it("deletes both entries and never touches the old personal-context key", async () => {
    const store = new FakeStore();
    await store.put("personal-context", { legacy: true });
    await saveProfile(store, { birthDate: "1990-05-15", fullName: "Alice Demo" });
    await deleteProfile(store);
    expect([...store.entries.keys()]).toEqual(["personal-context"]);
  });
});

describe("a vault reset clears every key", () => {
  it("removes entries it does not know the names of, such as one from before the scope keys", async () => {
    const { clearVault } = await import("../src/profile");
    const store = new FakeStore();
    await store.put("personal-context", { legacy: true });
    await store.put("personal/age", { birthDate: "1990-05-15" });
    await store.put("policies/x", { v: 1 });
    await clearVault({
      listKeys: async () => [...store.entries.keys()],
      delete: (key: string) => store.delete(key),
    });
    expect([...store.entries.keys()]).toEqual([]);
  });
});

describe("a partly written profile", () => {
  it("reports only the fields that exist, so the app can lay it over its defaults", async () => {
    const store = new FakeStore();
    await store.put("personal/age", { birthDate: "1990-05-15" });
    expect(await loadProfile(store)).toEqual({ birthDate: "1990-05-15" });
  });
});
