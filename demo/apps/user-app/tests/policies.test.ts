import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POLICY_KEY_PREFIX,
  type PolicyStore,
  deletePolicies,
  ensureSeedPolicy,
  listPolicies,
  policyKeyName,
  seedPolicy,
} from "../src/policies";

const ROOT = "did:key:z6MkseedOwner";

/** In-memory stand-in for the context store client: the same four calls, no crypto. */
class FakeStore implements PolicyStore {
  entries = new Map<string, unknown>();
  async listKeys(): Promise<string[]> {
    return [...this.entries.keys()];
  }
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

const vectors: { vectors: { name: string; policy: Record<string, unknown>; terms_hash: string }[] } =
  JSON.parse(
    readFileSync(new URL("../../../../spec/schemas/spal/v1.0/terms-vectors.json", import.meta.url), "utf8"),
  );

describe("seedPolicy", () => {
  it("embeds the root DID in id and owner and names the age rule", () => {
    const policy = seedPolicy(ROOT, "2026-11-07T00:00:00Z");
    expect(policy.id).toBe(`spal:${ROOT}:age-verification`);
    expect(policy.owner).toBe(ROOT);
    expect(policyKeyName(policy)).toBe("age-verification");
    expect(policy.rules[0].context_scope).toBe("personal/age");
    expect(policy.rules[0].conditions.identity?.type).toBe("ephemeral_required");
  });

  it("has the terms the agent's seed fixture has (spec vector demo-seed)", async () => {
    const vector = vectors.vectors.find((v) => v.name === "demo-seed");
    if (!vector) throw new Error("demo-seed vector missing");
    const store = new FakeStore();
    await ensureSeedPolicy(store, "did:key:z6MkanyOtherRoot");
    const [listed] = await listPolicies(store);
    expect(listed.termsHash).toBe(vector.terms_hash);
  });
});

describe("ensureSeedPolicy", () => {
  it("writes once", async () => {
    const store = new FakeStore();
    await ensureSeedPolicy(store, ROOT);
    await ensureSeedPolicy(store, ROOT);
    expect([...store.entries.keys()]).toEqual([`${POLICY_KEY_PREFIX}age-verification`]);
  });

  it("leaves an existing policy alone", async () => {
    const store = new FakeStore();
    await store.put(`${POLICY_KEY_PREFIX}mine`, { version: "1.0", rules: [] });
    await ensureSeedPolicy(store, ROOT);
    expect(store.entries.size).toBe(1);
  });
});

describe("listPolicies and deletePolicies", () => {
  it("lists policies under the prefix with their terms hash, skipping other keys", async () => {
    const store = new FakeStore();
    await ensureSeedPolicy(store, ROOT);
    await store.put("personal-context", { birthDate: "1990-05-15" });
    const listed = await listPolicies(store);
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe(`${POLICY_KEY_PREFIX}age-verification`);
    expect(listed[0].termsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deletes only the policies prefix", async () => {
    const store = new FakeStore();
    await ensureSeedPolicy(store, ROOT);
    await store.put("personal-context", { birthDate: "1990-05-15" });
    await deletePolicies(store);
    expect([...store.entries.keys()]).toEqual(["personal-context"]);
  });
});

describe("listPolicies with a damaged entry", () => {
  it("skips an entry that is not a policy and keeps the rest", async () => {
    const store = new FakeStore();
    await ensureSeedPolicy(store, ROOT);
    await store.put(`${POLICY_KEY_PREFIX}broken`, { version: "1.0", name: { not: "text" } });
    await store.put(`${POLICY_KEY_PREFIX}no-rules`, { version: "1.0", id: `spal:${ROOT}:no-rules`, name: "x", owner: ROOT });
    const listed = await listPolicies(store);
    expect(listed.map((p) => p.key)).toEqual([`${POLICY_KEY_PREFIX}age-verification`]);
  });
});
