/**
 * A policy's terms: what a business agrees to, with the holder's handles
 * removed.
 *
 * The terms are the contractual content of an S-PAL policy, produced by
 * allowlist and in a fixed shape so that nothing about who wrote the policy
 * or how survives into them: the version, each rule's scope and conditions
 * in a canonical order, and the enforcing validators. The protocol, and the
 * reasoning behind each dropped field, is `spec/protocols/policy-terms.md`;
 * `spec/schemas/spal/v1.0/terms-vectors.json` pins the bytes, and the agent's
 * `export_terms` reproduces them.
 */

import { canonicalJson } from "./preimage.js"

export interface PolicyTermsRule {
  context_scope: string
  conditions: Record<string, unknown>
}

export interface PolicyTerms {
  version: string
  rules: PolicyTermsRule[]
  enforcement?: { validators: string[] }
}

/**
 * The terms of `policy`, as the protocol's export step defines them.
 *
 * Works on the plain JSON object rather than a typed policy, so the same
 * bytes come out of a document before validation and out of the agent's copy
 * of it.
 *
 * @throws TypeError when `policy` has no `version` or no `rules` array: a
 *   policy without them has no terms, and partial terms are never produced.
 */
export function exportTerms(policy: Record<string, unknown>): PolicyTerms {
  const { version, rules, enforcement } = policy
  if (typeof version !== "string") {
    throw new TypeError("a policy without a version has no terms")
  }
  if (!Array.isArray(rules)) {
    throw new TypeError("a policy without rules has no terms")
  }
  const reduced: PolicyTermsRule[] = rules.map((rule) => {
    const { context_scope, conditions } = rule as Record<string, unknown>
    return {
      context_scope: context_scope as string,
      conditions: conditions as Record<string, unknown>,
    }
  })
  reduced.sort((a, b) => {
    if (a.context_scope !== b.context_scope) {
      return a.context_scope < b.context_scope ? -1 : 1
    }
    const ca = canonicalJson(a)
    const cb = canonicalJson(b)
    return ca < cb ? -1 : ca > cb ? 1 : 0
  })

  const terms: PolicyTerms = { version, rules: reduced }
  const validators =
    enforcement && typeof enforcement === "object"
      ? (enforcement as Record<string, unknown>).validators
      : undefined
  if (Array.isArray(validators) && validators.length > 0) {
    terms.enforcement = { validators: [...(validators as string[])].sort() }
  }
  return terms
}

/** SHA-256 of the canonical JSON of `policy`'s terms, as 64 lowercase hex characters. */
export async function termsHash(
  policy: Record<string, unknown>,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(exportTerms(policy)))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
}
