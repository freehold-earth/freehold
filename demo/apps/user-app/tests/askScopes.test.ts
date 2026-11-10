import { describe, expect, it } from "vitest";
import { askableScopes } from "../src/askScopes";

describe("askableScopes mirrors the agent's private-scope rule", () => {
  it("drops a private scope, anything under it and anything above it", () => {
    const rules = [
      { context_scope: "personal/age" },
      { context_scope: "identity" },
      { context_scope: "identity/authorizations" },
      { context_scope: "policies/age-verification" },
      { context_scope: "root-identity" },
    ];
    expect(askableScopes(rules)).toEqual(["personal/age"]);
  });

  it("keeps a scope that merely shares a prefix with a private one", () => {
    expect(askableScopes([{ context_scope: "identity-notes" }, { context_scope: "policiesx" }])).toEqual([
      "identity-notes",
      "policiesx",
    ]);
  });
});
