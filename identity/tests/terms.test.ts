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
