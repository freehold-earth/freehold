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

function wellFormedContext(context: AuthorizationContext): AuthorizationContext {
  const metadata = context.metadata
    ? Object.fromEntries(
        Object.entries(context.metadata).map(([k, v]) => [k, typeof v === "string" ? wellFormed(v) : v]),
      )
    : undefined;
  return { ...context, verificationType: wellFormed(context.verificationType), metadata };
}

async function authorizationKeys(store: AuthorizationStore): Promise<string[]> {
  return (await store.listKeys()).filter((k) => k.startsWith(AUTHORIZATION_KEY_PREFIX));
}

export interface IssuedAuthorization {
  /** The ephemeral DID to use for the verification */
  did: string;
  /** The record that proves the root authorized it, as stored */
  record: SerializedAuthorizationRecord;
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
  await store.put(randomKey(), record);
  return { did: issued.ephemeral.did, record };
}

/** Every stored record, newest first. */
export async function listAuthorizations(
  store: AuthorizationStore,
): Promise<SerializedAuthorizationRecord[]> {
  const keys = await authorizationKeys(store);
  const entries = await Promise.all(
    keys.map((key) => store.get<SerializedAuthorizationRecord>(key)),
  );
  return entries
    .flatMap((entry) => (entry ? [entry.data] : []))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
