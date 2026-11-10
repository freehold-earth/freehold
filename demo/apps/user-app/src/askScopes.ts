/**
 * Which of a policy's rule scopes an ask can be about: the agent refuses a
 * scope that reads private material, so the picker does not offer one.
 * The rule mirrors the agent's: a private scope, anything under it, and
 * anything above it; never a scope that merely shares a prefix.
 */

/** The scopes the agent never sends to a model. */
export const PRIVATE_SCOPES = ["root-identity", "identity", "policies"] as const;

function inScope(key: string, scope: string): boolean {
  return key === scope || key.startsWith(`${scope}/`);
}

export function askableScopes(rules: { context_scope: string }[]): string[] {
  return rules
    .map((r) => r.context_scope)
    .filter((s) => !PRIVATE_SCOPES.some((p) => inScope(s, p) || inScope(p, s)));
}
