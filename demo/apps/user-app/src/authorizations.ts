/**
 * Authorization records: the local, encrypted proof that an ephemeral DID is ours.
 *
 * Every verification is answered under a fresh ephemeral DID that no business
 * can link to our root DID or to any other verification. What makes that DID
 * provably ours later (legal discovery, a dispute, an audit) is an
 * authorization record the root key signed when the DID was issued. The
 * record is the user's own evidence: it is kept encrypted in the context
 * store, under keys the agent never reads for a claim, and it is never sent
 * to a verifier. The ephemeral keypair itself is single-use and is not kept;
 * the record is what matters afterwards. A record carries no expiry: it is
 * evidence about the past, and verification treats an expired record as
 * invalid, so expiring it would defeat the audit it exists for. How long the
 * DID was meant to be used for is metadata, not validity.
 *
 * Records live under `identity/authorizations/<random id>`. The store sees
 * keys in the clear (only values are encrypted) and may sync them to other
 * devices, so the key must not carry the ephemeral DID: a list of our DIDs
 * is exactly the linkage the privacy model denies third parties. The DID is
 * inside the encrypted record only. The `identity` domain is separate from
 * `personal`, so an agent reading an age claim's scope never touches them.
 */

import {
  type AuthorizationContext,
  deserializeDIDKeyPair,
  generateAuthorizedEphemeralDID,
  type SerializedAuthorizationRecord,
  serializeAuthorizationRecord,
} from "@freehold-earth/identity";
import type { RootIdentity } from "./types";

export const AUTHORIZATION_KEY_PREFIX = "identity/authorizations/";

/** The slice of the context store client these functions need. */
export interface AuthorizationStore {
  listKeys(): Promise<string[]>;
  get<T>(key: string): Promise<{ data: T } | null>;
  put<T>(key: string, data: T): Promise<unknown>;
  delete(key: string): Promise<boolean>;
}

/** A random key for a record; getRandomValues works in insecure contexts where randomUUID does not. */
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return AUTHORIZATION_KEY_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The string with any lone UTF-16 surrogate replaced by U+FFFD. The record is
 * signed over a canonical encoding that refuses lone surrogates, and some of
 * what goes into it (a business name, an id) arrived over the network.
 */
export function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/**
 * ``value`` with every string in it well-formed, at any depth, and absent
 * (undefined) object members left out. Two keys that differ only by a lone
 * surrogate collapse into one; the keys here are the app's own, so none do.
 */
function wellFormedValue(value: unknown): unknown {
  if (typeof value === "string") return wellFormed(value);
  if (Array.isArray(value)) return value.map(wellFormedValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [wellFormed(k), wellFormedValue(v)]),
    );
  }
  return value;
}

function wellFormedContext(context: AuthorizationContext): AuthorizationContext {
  return wellFormedValue(context) as AuthorizationContext;
}

/**
 * Whether a stored value has the shape the Identity tab and the export need.
 * This is a shape check, not verification: an auditor verifies the signature
 * with the identity library, which is what the export is for.
 */
function isRecord(value: unknown): value is SerializedAuthorizationRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ephemeralDid === "string" &&
    typeof v.rootDid === "string" &&
    typeof v.purpose === "string" &&
    typeof v.context === "object" &&
    v.context !== null &&
    typeof v.timestamp === "string" &&
    Array.isArray(v.rootSignature)
  );
}

async function authorizationKeys(store: AuthorizationStore): Promise<string[]> {
  return (await store.listKeys()).filter((k) => k.startsWith(AUTHORIZATION_KEY_PREFIX));
}

export interface IssuedAuthorization {
  /** The ephemeral DID to use for the verification */
  did: string;
  /** The record that proves the root authorized it, as stored */
  record: SerializedAuthorizationRecord;
  /** Where it is stored, so an issue that is not followed by a use can be undone */
  key: string;
}

/** What "Export for audit" produces: everything an auditor needs to verify the records. */
export interface AuditExport {
  exportedAt: string;
  rootDid: string;
  records: SerializedAuthorizationRecord[];
}

/**
 * Issue an ephemeral DID authorized by the root identity and keep its record.
 *
 * Strings in the purpose and context metadata are made well-formed first,
 * since the signature is over a canonical encoding that refuses otherwise.
 */
export async function issueAuthorizedDid(
  store: AuthorizationStore,
  root: RootIdentity,
  purpose: string,
  context: AuthorizationContext,
): Promise<IssuedAuthorization> {
  const keyPair = deserializeDIDKeyPair(root);
  const issued = await generateAuthorizedEphemeralDID(
    keyPair,
    wellFormed(purpose),
    wellFormedContext(context),
  );
  const record = serializeAuthorizationRecord(issued.authorization);
  const key = randomKey();
  await store.put(key, record);
  return { did: issued.ephemeral.did, record, key };
}

/** Remove one record, e.g. when the verification it was issued for never went ahead. */
export async function deleteAuthorization(store: AuthorizationStore, key: string): Promise<boolean> {
  return store.delete(key);
}

/**
 * Every stored record, newest first. A value that is not a record, or one
 * that cannot be read or decrypted, is skipped with a warning so the rest
 * still list; only the listing itself failing rejects.
 */
export async function listAuthorizations(
  store: AuthorizationStore,
): Promise<SerializedAuthorizationRecord[]> {
  const keys = await authorizationKeys(store);
  const results = await Promise.allSettled(keys.map((key) => store.get<unknown>(key)));
  const records: SerializedAuthorizationRecord[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.warn(`Skipping ${keys[i]}: could not be read`, result.reason);
    } else if (result.value && isRecord(result.value.data)) {
      records.push(result.value.data);
    } else if (result.value) {
      console.warn(`Skipping ${keys[i]}: not an authorization record`);
    }
  });
  return sortNewestFirst(records);
}

/** Newest first by ISO 8601 timestamp, which orders as plain text. */
export function sortNewestFirst(
  records: SerializedAuthorizationRecord[],
): SerializedAuthorizationRecord[] {
  return [...records].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

/** The union of two record lists by ephemeral DID, newest first. */
export function mergeAuthorizations(
  known: SerializedAuthorizationRecord[],
  loaded: SerializedAuthorizationRecord[],
): SerializedAuthorizationRecord[] {
  const byDid = new Map(known.map((r) => [r.ephemeralDid, r]));
  for (const record of loaded) byDid.set(record.ephemeralDid, record);
  return sortNewestFirst([...byDid.values()]);
}

/** Remove every stored record (vault reset). Returns how many were removed. */
export async function deleteAuthorizations(store: AuthorizationStore): Promise<number> {
  const keys = await authorizationKeys(store);
  const results = await Promise.all(keys.map((key) => store.delete(key)));
  return results.filter(Boolean).length;
}

/** Bundle the records with the root DID they were issued under, for an auditor. */
export function auditExport(
  rootDid: string,
  records: SerializedAuthorizationRecord[],
): AuditExport {
  return { exportedAt: new Date().toISOString(), rootDid, records };
}
