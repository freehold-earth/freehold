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
  const reduced: PolicyTermsRule[] = rules.map(exportRule)
  reduced.sort(
    (a, b) =>
      compareUtf16(a.context_scope, b.context_scope) ||
      compareUtf16(canonicalJson(a), canonicalJson(b)),
  )

  const terms: PolicyTerms = { version, rules: reduced }
  const validators = isRecord(enforcement) ? enforcement.validators : undefined
  if (Array.isArray(validators) && validators.length > 0) {
    if (!validators.every((v) => typeof v === "string")) {
      throw new TypeError("enforcement validators must be text")
    }
    terms.enforcement = { validators: [...validators].sort(compareUtf16) }
  }
  return terms
}

/** The order the protocol fixes: UTF-16 code units, as RFC 8785 orders keys and `<` compares strings. */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A rule reduced to its terms; a rule that is not one has no terms. */
function exportRule(rule: unknown): PolicyTermsRule {
  if (!isRecord(rule)) throw new TypeError("a rule must be an object")
  const { context_scope, conditions } = rule
  if (typeof context_scope !== "string") {
    throw new TypeError("a rule's context_scope must be text")
  }
  if (!isRecord(conditions))
    throw new TypeError("a rule's conditions must be an object")
  return { context_scope, conditions: exportConditions(conditions) }
}

// The S-PAL 1.0 conditions, and 1.1's custody, and the fields of each. A condition or field not
// listed here is not part of the terms until the protocol says it is.
const CONDITION_FIELDS: Record<string, readonly string[]> = {
  identity: ["type", "linkage"],
  retention: ["max_seconds", "audit_log"],
  derivatives: ["training", "aggregation", "resale"],
  payment: ["protocol", "amount", "currency"],
  custody: ["operator", "hosted_models", "attestation_required"],
}
const PROOF_FIELDS = ["type", "claim", "params"] as const
const LINKAGE_FIELDS = [
  "ephemeral_required",
  "proof_of_root_allowed",
  "zk_continuity_allowed",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function pick(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of fields) {
    if (name in source) out[name] = source[name]
  }
  return out
}

// The integer fields of the 1.0 conditions: non-negative integers up to
// Number.MAX_SAFE_INTEGER, the range every implementation holds exactly.
// Anything else there has no terms, so the two exports cannot disagree.
const INTEGER_FIELDS: Record<string, readonly string[]> = {
  retention: ["max_seconds"],
  payment: ["amount"],
}

/** The conditions a rule's terms carry: the 1.0 conditions, each by its own allowlist. */
function exportConditions(
  conditions: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, fields] of Object.entries(CONDITION_FIELDS)) {
    const value = conditions[name]
    if (isRecord(value)) {
      const picked = pick(value, fields)
      if (isRecord(picked.linkage))
        picked.linkage = pick(picked.linkage, LINKAGE_FIELDS)
      for (const field of INTEGER_FIELDS[name] ?? []) {
        const n = picked[field]
        if (
          n !== undefined &&
          !(typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
        ) {
          throw new TypeError(`${name}.${field} must be a safe integer`)
        }
      }
      out[name] = picked
    }
  }
  const proofs = conditions.proofs
  if (Array.isArray(proofs)) {
    out.proofs = proofs.filter(isRecord).map((p) => {
      const picked = pick(p, PROOF_FIELDS)
      assertSafeNumbers(picked.params, "proofs[].params")
      return picked
    })
  }
  return out
}

/**
 * Refuse an integer no implementation holds exactly, anywhere in free-form
 * params: the agent's canonical JSON refuses such an integer, so hashing it
 * here would produce a hash the agent cannot reproduce.
 */
function assertSafeNumbers(value: unknown, where: string): void {
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${where} must hold safe integers`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeNumbers(item, where)
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) assertSafeNumbers(item, where)
  }
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
