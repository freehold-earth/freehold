import { describe, expect, it } from "vitest";
import { formatSpecks, proofCost, shortAddress } from "../src/costs";

describe("proofCost", () => {
  it("reads the DUST an on-chain proof cost from its fee field", () => {
    const cost = proofCost({ verificationMethod: "on-chain", dustFee: "1250000000000" });
    expect(cost).toEqual({ kind: "on-chain", specks: BigInt("1250000000000") });
  });

  it("keeps a fee beyond the safe-integer range exact", () => {
    const cost = proofCost({ dustFee: "123456789012345678901234567890" });
    expect(cost).toEqual({ kind: "on-chain", specks: BigInt("123456789012345678901234567890") });
  });

  it("reports an offline proof as costing nothing", () => {
    expect(proofCost({ verificationMethod: "offline" })).toEqual({ kind: "offline" });
  });

  it("reports nothing for a proof without a fee or no proof at all", () => {
    expect(proofCost({ verificationMethod: "on-chain", txId: "0xabc" })).toEqual({ kind: "unreported" });
    expect(proofCost(null)).toEqual({ kind: "unreported" });
    expect(proofCost(undefined)).toEqual({ kind: "unreported" });
  });

  it("does not read a fee that is not a decimal string", () => {
    for (const dustFee of [12, "", "-5", "1e9", "0x10", " 7", {}]) {
      expect(proofCost({ dustFee })).toEqual({ kind: "unreported" });
    }
  });
});

describe("formatSpecks", () => {
  it("separates thousands and pluralises", () => {
    expect(formatSpecks(BigInt(0))).toBe("0 specks");
    expect(formatSpecks(BigInt(1))).toBe("1 speck");
    expect(formatSpecks(BigInt("1250000000000"))).toBe("1,250,000,000,000 specks");
  });
});

describe("shortAddress", () => {
  it("keeps a short address whole and shortens a long one at both ends", () => {
    expect(shortAddress("mn_dust_undeployed1abc")).toBe("mn_dust_undeployed1abc");
    const long = `mn_dust_undeployed1${"q".repeat(60)}xyz123`;
    expect(shortAddress(long)).toBe("mn_dust_undeploy…xyz123");
  });
});
