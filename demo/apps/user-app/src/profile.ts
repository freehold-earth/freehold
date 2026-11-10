/**
 * The holder's profile, kept one entry per scope.
 *
 * A rule in a policy names a scope, and the agent reads exactly that scope,
 * so each fact lives under the key a rule would name: the birth date under
 * `personal/age`, the name under `personal/name`. An ask or a proof about
 * age then never carries the name along with it.
 */

import type { PersonalContext } from "./types";

/** The three store calls the profile needs; the context store client satisfies it. */
export interface ProfileStore {
  get<T>(key: string): Promise<{ data: T } | null>;
  put<T>(key: string, data: T): Promise<unknown>;
  delete(key: string): Promise<boolean>;
}

export const AGE_KEY = "personal/age";
export const NAME_KEY = "personal/name";

/** The profile, or null when neither entry exists yet. */
export async function loadProfile(store: ProfileStore): Promise<PersonalContext | null> {
  const [age, name] = await Promise.all([
    store.get<{ birthDate?: string }>(AGE_KEY),
    store.get<{ fullName?: string }>(NAME_KEY),
  ]);
  if (!age && !name) return null;
  return { birthDate: age?.data.birthDate, fullName: name?.data.fullName };
}

/** Write the profile as its two entries. */
export async function saveProfile(store: ProfileStore, profile: PersonalContext): Promise<void> {
  await Promise.all([
    store.put(AGE_KEY, { birthDate: profile.birthDate }),
    store.put(NAME_KEY, { fullName: profile.fullName }),
  ]);
}

/** Remove both entries, as a vault reset does. */
export async function deleteProfile(store: ProfileStore): Promise<void> {
  await Promise.all([store.delete(AGE_KEY), store.delete(NAME_KEY)]);
}
