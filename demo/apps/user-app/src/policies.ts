/**
 * The holder's S-PAL policies, kept in the vault.
 *
 * A policy is the holder's data: it lives in the context store, encrypted
 * like everything else, under `policies/{name}` where `name` is the last
 * segment of its id `spal:{owner DID}:{name}`. The owner DID stays inside
 * the encrypted value; the store sees keys in the clear and may sync them.
 * The agent reads policies here at every decision, so what this file writes
 * is what decides. The shape is the spec's (spec/schemas/spal/v1.0), not a
 * local one: the agent validates exactly this document.
 */

import { exportTerms, termsHash } from "@freehold-earth/identity";

export const POLICY_KEY_PREFIX = "policies/";

/** The four store calls policies need; the context store client satisfies it. */
export interface PolicyStore {
  listKeys(): Promise<string[]>;
  get<T>(key: string): Promise<{ data: T } | null>;
  put<T>(key: string, data: T): Promise<unknown>;
  delete(key: string): Promise<boolean>;
}

// --- The S-PAL 1.0 policy shape (spec/schemas/spal/v1.0/schema.json) ---

export type IdentityType = "ephemeral_required" | "persistent_allowed" | "any";
export type ProofType = "zkp" | "attestation" | "signature";
export type DerivativePermission =
  | "forbidden"
  | "allowed"
  | "requires_payment"
  | "requires_consent"
  | "anonymized_only";

export interface IdentityLinkage {
  ephemeral_required: boolean;
  proof_of_root_allowed?: boolean;
  zk_continuity_allowed?: boolean;
}

export interface Conditions {
  identity?: { type?: IdentityType; linkage?: IdentityLinkage | "forbidden" | "allowed" };
  proofs?: { type: ProofType; claim: string; params?: Record<string, unknown> }[];
  retention?: { max_seconds: number; audit_log?: boolean };
  derivatives?: {
    training?: DerivativePermission;
    aggregation?: DerivativePermission;
    resale?: DerivativePermission;
  };
  payment?: { protocol: "x402" | "lightning" | "cardano"; amount: number; currency: "sats" | "lovelace" | "usd_cents" };
}

export interface AccessRule {
  id: string;
  context_scope: string;
  conditions: Conditions;
}

export type SPALPolicy = {
  version: "1.0";
  /** `spal:{owner DID}:{name}`; the agent requires the owner to match */
  id: string;
  name: string;
  description?: string;
  /** The holder's root DID; never shown to a business */
  owner: string;
  rules: AccessRule[];
  enforcement?: { smart_contract?: string; validators?: string[]; dispute_resolution?: string };
  created?: string;
  updated?: string;
  signature?: string;
};

/** A policy as listed from the vault, with the hash of its terms. */
export interface StoredPolicy {
  key: string;
  policy: SPALPolicy;
  termsHash: string;
}

/** The name segment of a policy's id: its key under `policies/`. */
export function policyKeyName(policy: SPALPolicy): string {
  return policy.id.slice(policy.id.lastIndexOf(":") + 1);
}

/**
 * The demo's one policy: age may be verified by a business that holds an
 * ephemeral identity and receives a zero-knowledge proof; nothing is kept
 * and nothing is derived. Its terms match the agent's seed fixture (the
 * `demo-seed` vector of spec/schemas/spal/v1.0/terms-vectors.json).
 */
export function seedPolicy(rootDid: string, now: string): SPALPolicy {
  return {
    version: "1.0",
    id: `spal:${rootDid}:age-verification`,
    name: "Age Verification Only",
    description: "Allow businesses to verify age without revealing birth date",
    owner: rootDid,
    created: now,
    updated: now,
    rules: [
      {
        id: "rule-age",
        context_scope: "personal/age",
        conditions: {
          identity: { type: "ephemeral_required" },
          proofs: [{ type: "zkp", claim: "age" }],
          retention: { max_seconds: 0, audit_log: true },
          derivatives: { training: "forbidden", aggregation: "forbidden", resale: "forbidden" },
        },
      },
    ],
  };
}

async function policyKeys(store: PolicyStore): Promise<string[]> {
  return (await store.listKeys()).filter((k) => k.startsWith(POLICY_KEY_PREFIX)).sort();
}

/** Seed the demo policy when the vault holds no policy at all. */
export async function ensureSeedPolicy(store: PolicyStore, rootDid: string): Promise<void> {
  if ((await policyKeys(store)).length > 0) return;
  const policy = seedPolicy(rootDid, new Date().toISOString());
  await store.put(POLICY_KEY_PREFIX + policyKeyName(policy), policy);
}

/**
 * Whether a vault value has the shape this app renders and the agent reads:
 * the fields the Policies tab and the service request touch, as the types
 * say. The agent validates the full document; this keeps one damaged entry
 * from taking the page down.
 */
export function isPolicyShaped(value: unknown): value is SPALPolicy {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.version === "1.0" &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.owner === "string" &&
    (p.description === undefined || typeof p.description === "string") &&
    Array.isArray(p.rules) &&
    p.rules.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as Record<string, unknown>).id === "string" &&
        typeof (r as Record<string, unknown>).context_scope === "string" &&
        typeof (r as Record<string, unknown>).conditions === "object" &&
        (r as Record<string, unknown>).conditions !== null,
    )
  );
}

/**
 * Every usable policy in the vault, by key, with the hash of its terms. An
 * entry that is not a policy, or whose terms cannot be exported, is skipped
 * with a warning so the rest still list; the agent refuses it on its own.
 */
export async function listPolicies(store: PolicyStore): Promise<StoredPolicy[]> {
  const listed: StoredPolicy[] = [];
  for (const key of await policyKeys(store)) {
    const entry = await store.get<unknown>(key);
    if (!entry) continue;
    if (!isPolicyShaped(entry.data)) {
      console.warn(`Skipping ${key}: not a policy`);
      continue;
    }
    try {
      listed.push({ key, policy: entry.data, termsHash: await termsHash(entry.data) });
    } catch (err) {
      console.warn(`Skipping ${key}: its terms cannot be exported`, err);
    }
  }
  return listed;
}

/** Whether a policy has a rule governing ``scope`` (the rule's scope or a path under it). */
export function governs(policy: SPALPolicy, scope: string): boolean {
  return policy.rules.some(
    (r) => scope === r.context_scope || scope.startsWith(`${r.context_scope}/`),
  );
}

/** Remove every policy, as a vault reset does; a policy must not outlive its owner. */
export async function deletePolicies(store: PolicyStore): Promise<void> {
  for (const key of await policyKeys(store)) {
    await store.delete(key);
  }
}

/** What a business is shown of a policy: its terms, by the protocol's export. */
export function termsOf(policy: SPALPolicy) {
  return exportTerms(policy);
}
