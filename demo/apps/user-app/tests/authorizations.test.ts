import {
  deserializeAuthorizationRecord,
  generateDID,
  serializeDIDKeyPair,
  verifyAuthorizationRecord,
} from "@freehold-earth/identity";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_KEY_PREFIX,
  type AuthorizationStore,
  auditExport,
  deleteAuthorizations,
  issueAuthorizedDid,
  listAuthorizations,
} from "../src/authorizations";
import type { RootIdentity } from "../src/types";

/** In-memory stand-in for the context store client: the same four calls, no crypto. */
class FakeStore implements AuthorizationStore {
  entries = new Map<string, unknown>();
  async listKeys(): Promise<string[]> {
    return [...this.entries.keys()];
  }
  async get<T>(key: string): Promise<{ data: T } | null> {
    return this.entries.has(key) ? { data: this.entries.get(key) as T } : null;
  }
  async put<T>(key: string, data: T): Promise<void> {
    this.entries.set(key, data);
  }
  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }
}

async function root(): Promise<RootIdentity> {
  const s = serializeDIDKeyPair(await generateDID());
  return { did: s.did, publicKey: s.publicKey, privateKey: s.privateKey, createdAt: s.createdAt };
}

const context = { verificationType: "age", metadata: { businessId: "demo-business" } };

describe("issueAuthorizedDid", () => {
  it("stores a record the root DID verifies, under a key that does not name the DID", async () => {
    const store = new FakeStore();
    const identity = await root();

    const issued = await issueAuthorizedDid(store, identity, "Age verification at Demo", context);

    expect(issued.did).toMatch(/^did:key:z/);
    expect(issued.did).not.toBe(identity.did);
    const [key] = [...store.entries.keys()];
    expect(key.startsWith(AUTHORIZATION_KEY_PREFIX)).toBe(true);
    expect(key).not.toContain(issued.did);
    expect(key).not.toContain(identity.did);
    const record = deserializeAuthorizationRecord(issued.record);
    expect(record.rootDid).toBe(identity.did);
    expect(record.ephemeralDid).toBe(issued.did);
    expect(await verifyAuthorizationRecord(record)).toBe(true);
  });

  it("keeps the records in the identity domain, not the personal one", async () => {
    const store = new FakeStore();
    await issueAuthorizedDid(store, await root(), "p", context);
    for (const key of store.entries.keys()) {
      expect(key.startsWith("identity/")).toBe(true);
      expect(key.startsWith("personal")).toBe(false);
    }
  });

  it("bounds the authorization by the expiry it is given", async () => {
    const store = new FakeStore();
    const issued = await issueAuthorizedDid(store, await root(), "p", context, 60_000);
    const expires = new Date(issued.record.expiresAt ?? "").getTime();
    expect(expires - Date.now()).toBeGreaterThan(50_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(60_000);
  });
});

describe("listAuthorizations", () => {
  it("returns only records, newest first", async () => {
    const store = new FakeStore();
    const identity = await root();
    await store.put("personal-context", { birthDate: "1990-05-15" });
    const first = await issueAuthorizedDid(store, identity, "first", context);
    await new Promise((r) => setTimeout(r, 5));
    const second = await issueAuthorizedDid(store, identity, "second", context);

    const records = await listAuthorizations(store);

    expect(records.map((r) => r.ephemeralDid)).toEqual([second.did, first.did]);
  });
});

describe("auditExport", () => {
  it("round-trips every record through the identity package and verifies", async () => {
    const store = new FakeStore();
    const identity = await root();
    await issueAuthorizedDid(store, identity, "a", context);
    await issueAuthorizedDid(store, identity, "b", context);

    const exported = auditExport(identity.did, await listAuthorizations(store));
    const parsed = JSON.parse(JSON.stringify(exported)) as typeof exported;

    expect(parsed.rootDid).toBe(identity.did);
    expect(parsed.records).toHaveLength(2);
    for (const serialized of parsed.records) {
      const record = deserializeAuthorizationRecord(serialized);
      expect(record.rootDid).toBe(identity.did);
      expect(await verifyAuthorizationRecord(record)).toBe(true);
    }
  });
});

describe("deleteAuthorizations", () => {
  it("removes the records and nothing else", async () => {
    const store = new FakeStore();
    await store.put("personal-context", { birthDate: "1990-05-15" });
    await store.put("root-identity", { did: "did:key:z" });
    await issueAuthorizedDid(store, await root(), "p", context);
    await issueAuthorizedDid(store, await root(), "q", context);

    expect(await deleteAuthorizations(store)).toBe(2);
    expect([...store.entries.keys()].sort()).toEqual(["personal-context", "root-identity"]);
  });
});
