/**
 * Throwaway private state for ephemeral contracts.
 *
 * Every proof deploys a contract of its own, so the private state and signing
 * key the Midnight providers persist for it are worthless once the call ends.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import type { PrivateStateProvider } from "@midnight-ntwrk/midnight-js-types";
import { MemoryLevel } from "memory-level";

/**
 * A random password the provider's strength policy always accepts.
 *
 * The policy wants three character classes and rejects four identical or four
 * consecutive characters in a row, which a plain random string only meets
 * most of the time. A separator after every pair of hex digits caps any run
 * at two, and the fixed prefix supplies the upper- and lowercase classes
 * whatever the digits turn out to be.
 */
export function storagePassword(): string {
  return `Fh-${randomBytes(16).toString("hex").replace(/(..)(?=.)/g, "$1-")}`;
}

/**
 * Run `fn` with a private state provider whose storage exists only for the call.
 *
 * The provider opens and closes its database around every operation and has
 * no close or dispose of its own, so the store is an in-memory database held
 * only by this call: nothing reaches disk, and it is garbage once `fn`
 * settles. The provider also caches encryption material under the database
 * name, so the name is unique per call and the entry is dropped afterwards.
 *
 * Because the store is opened and closed around each operation, operations
 * on the provider must not overlap; `fn` has to await each before the next,
 * and must not use the provider after it returns.
 */
export async function withEphemeralPrivateState<T>(
  fn: (provider: PrivateStateProvider) => Promise<T>,
): Promise<T> {
  const store = new MemoryLevel<string, string>();
  const password = storagePassword();
  const provider = levelPrivateStateProvider({
    midnightDbName: `freehold-age-verification-${randomUUID()}`,
    accountId: "freehold-age-verification",
    privateStoragePasswordProvider: () => password,
    levelFactory: () => store,
  });

  try {
    return await fn(provider);
  } finally {
    await provider.invalidateEncryptionCache();
  }
}
