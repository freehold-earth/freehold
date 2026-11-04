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
 * the record is what matters afterwards.
 *
 * Records live under `identity/authorizations/<ephemeral DID>`. The
 * `identity` domain is separate from `personal`, so an agent reading an age
 * claim's scope never touches them.
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
 * @param expiresInMs - How long the authorization stands; a verification's own
 *   expiry is the natural choice, so the DID is not usable after the request is.
 */
export async function issueAuthorizedDid(
  store: AuthorizationStore,
  root: RootIdentity,
  purpose: string,
  context: AuthorizationContext,
  expiresInMs?: number,
): Promise<IssuedAuthorization> {
  const keyPair = deserializeDIDKeyPair(root);
  const issued = await generateAuthorizedEphemeralDID(keyPair, purpose, context, expiresInMs);
  const record = serializeAuthorizationRecord(issued.authorization);
  await store.put(AUTHORIZATION_KEY_PREFIX + issued.ephemeral.did, record);
  return { did: issued.ephemeral.did, record };
}

/** Every stored record, newest first. */
export async function listAuthorizations(
  store: AuthorizationStore,
): Promise<SerializedAuthorizationRecord[]> {
  const keys = (await store.listKeys()).filter((k) => k.startsWith(AUTHORIZATION_KEY_PREFIX));
  const entries = await Promise.all(
    keys.map((key) => store.get<SerializedAuthorizationRecord>(key)),
  );
  return entries
    .flatMap((entry) => (entry ? [entry.data] : []))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Remove every stored record (vault reset). Returns how many were removed. */
export async function deleteAuthorizations(store: AuthorizationStore): Promise<number> {
  const keys = (await store.listKeys()).filter((k) => k.startsWith(AUTHORIZATION_KEY_PREFIX));
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
