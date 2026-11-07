import { describe, expect, it } from "vitest";
import { describeTerms } from "../src/terms";

const SEED_TERMS = {
  version: "1.0",
  rules: [
    {
      context_scope: "personal/age",
      conditions: {
        identity: { type: "ephemeral_required" },
        proofs: [{ type: "zkp", claim: "age" }],
        retention: { max_seconds: 0, audit_log: true },
        derivatives: { training: "forbidden", aggregation: "forbidden", resale: "forbidden" },
      },
    },
  ],
};

describe("describeTerms", () => {
  it("renders the seed policy's rule as plain lines a business can read", () => {
    const lines = describeTerms(SEED_TERMS);
    expect(lines.join("\n")).toMatch(/ephemeral/i);
    expect(lines.join("\n")).toMatch(/no retention/i);
    expect(lines.join("\n")).toMatch(/no training/i);
    expect(lines.join("\n")).toMatch(/zero-knowledge proof of age/i);
    expect(lines[0]).toMatch(/personal\/age/);
  });

  it("says so when the terms carry no rules it can describe", () => {
    expect(describeTerms({ version: "1.0", rules: [] })).toEqual(["No rules."]);
  });

  it("does not throw on terms shaped unexpectedly", () => {
    expect(describeTerms({})).toEqual(["No rules."]);
    expect(describeTerms({ rules: [{ context_scope: "x" }] })).toEqual(["x: no conditions"]);
  });
});
