import { describe, expect, it } from "vitest";
import { parseAskAnswer } from "../src/askAnswer";

describe("parseAskAnswer", () => {
  it("accepts the agent's answer shape", () => {
    expect(parseAskAnswer({ answer: "36", rule_id: "rule-age", context_used: ["personal-context"] })).toEqual({
      answer: "36",
      rule_id: "rule-age",
      context_used: ["personal-context"],
    });
  });

  it("rejects anything else rather than letting it reach the page", () => {
    expect(parseAskAnswer({})).toBeNull();
    expect(parseAskAnswer({ answer: "36" })).toBeNull();
    expect(parseAskAnswer({ answer: 1, rule_id: "r", context_used: [] })).toBeNull();
    expect(parseAskAnswer({ answer: "36", rule_id: "r", context_used: [1] })).toBeNull();
    expect(parseAskAnswer("36")).toBeNull();
    expect(parseAskAnswer(null)).toBeNull();
  });
});
