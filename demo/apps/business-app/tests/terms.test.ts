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
    expect(describeTerms({ rules: [{ context_scope: "x" }] })[0]).toMatch(
      /^x: the data may be worked on by hardware the customer controls/,
    );
  });
});

describe("describeTerms conditional permissions", () => {
  it("shows a conditional derivative permission, not silence", () => {
    const lines = describeTerms({
      version: "1.0",
      rules: [
        {
          context_scope: "personal/age",
          conditions: {
            derivatives: { training: "requires_payment", aggregation: "anonymized_only", resale: "requires_consent" },
          },
        },
      ],
    });
    const text = lines.join("\n");
    expect(text).toMatch(/training.*payment/i);
    expect(text).toMatch(/aggregation.*anonymi/i);
    expect(text).toMatch(/resale.*consent/i);
    expect(text).not.toMatch(/no conditions/);
  });
});

describe("describeTerms custody", () => {
  it("says whose machine may work on the data, and the default when a rule is silent", () => {
    const lines = describeTerms({
      version: "1.1",
      rules: [
        { context_scope: "personal/age", conditions: { custody: { operator: "federated_operator" } } },
        { context_scope: "personal/email", conditions: {} },
      ],
    });
    expect(lines[0]).toMatch(/federated operator/i);
    expect(lines[1]).toMatch(/hardware the customer controls/i);
  });
});

describe("describeTerms shows every custody field", () => {
  it("names hosted models and attestation when the rule states them", () => {
    const line = describeTerms({
      rules: [
        {
          context_scope: "health/x",
          conditions: {
            custody: { operator: "attested_enclave", hosted_models: "allowed", attestation_required: true },
          },
        },
      ],
    })[0];
    expect(line).toMatch(/hosted models allowed/);
    expect(line).toMatch(/attestation required/);
  });
  it("says hosted models are not allowed by default", () => {
    const line = describeTerms({ rules: [{ context_scope: "x", conditions: {} }] })[0];
    expect(line).toMatch(/no hosted models/);
  });
});
