import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { canonicalJson } from "../src/preimage.js"
import { exportTerms, termsHash } from "../src/terms.js"

interface Vector {
  name: string
  policy: Record<string, unknown>
  terms_canonical_json: string
  terms_hash: string
}

const spec: { vectors: Vector[] } = JSON.parse(
  readFileSync(
    new URL("../../spec/schemas/spal/v1.0/terms-vectors.json", import.meta.url),
    "utf8",
  ),
)

describe("exportTerms", () => {
  it.each(spec.vectors)("reproduces the spec vector $name", async (vector) => {
    expect(canonicalJson(exportTerms(vector.policy))).toBe(
      vector.terms_canonical_json,
    )
    expect(await termsHash(vector.policy)).toBe(vector.terms_hash)
  })

  it("drops unknown fields rather than copying them", () => {
    const base = spec.vectors[0].policy
    const rules = (base.rules as Record<string, unknown>[]).map((r, i) =>
      i === 0 ? { ...r, note: "x" } : r,
    )
    const terms = exportTerms({ ...base, persona: { type: "personal" }, rules })
    expect("persona" in terms).toBe(false)
    expect("note" in terms.rules[0]).toBe(false)
  })

  it("throws without rules or version", () => {
    expect(() => exportTerms({ version: "1.0" })).toThrow(/rules/)
    expect(() => exportTerms({ rules: [] })).toThrow(/version/)
  })
})

describe("exportTerms conditions", () => {
  it("exports conditions by allowlist too", () => {
    const base = structuredClone(spec.vectors[0].policy) as Record<
      string,
      unknown
    >
    const rules = base.rules as Record<string, unknown>[]
    const conditions = rules[0].conditions as Record<string, unknown>
    conditions.processing = { locality: "device_only" }
    conditions.retention = { max_seconds: 0, audit_log: true, shred: true }
    conditions.proofs = [
      { type: "zkp", claim: "x", params: { k: 1 }, note: "n" },
    ]
    const scope = rules[0].context_scope
    const exported = exportTerms(base).rules.find(
      (r) => r.context_scope === scope,
    )
    expect(exported?.conditions.processing).toBeUndefined()
    expect(exported?.conditions.retention).toEqual({
      max_seconds: 0,
      audit_log: true,
    })
    expect(exported?.conditions.proofs).toEqual([
      { type: "zkp", claim: "x", params: { k: 1 } },
    ])
  })
})

describe("exportTerms shape", () => {
  it("sorts rules by UTF-16 code units, like canonical JSON keys", () => {
    const vector = spec.vectors.find((v) => v.name === "utf16-order")
    if (!vector) throw new Error("vector missing")
    const scopes = exportTerms(vector.policy).rules.map((r) => r.context_scope)
    expect(scopes).toEqual(["personal/\u{1f600}", "personal/～"])
  })

  it.each([
    ["not an object", "not a rule"],
    ["scope not text", { context_scope: 7, conditions: {} }],
    ["no conditions", { context_scope: "a/b" }],
    ["conditions not an object", { context_scope: "a/b", conditions: [] }],
  ])("a malformed rule (%s) has no terms", (_label, rule) => {
    expect(() => exportTerms({ version: "1.0", rules: [rule] })).toThrow(/rule/)
  })

  it("requires validators to be text", () => {
    const policy = {
      version: "1.0",
      rules: [],
      enforcement: { validators: ["cardano", 1] },
    }
    expect(() => exportTerms(policy)).toThrow(/validators/)
  })
})
