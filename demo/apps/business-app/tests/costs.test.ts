import { describe, expect, it } from "vitest";
import { formatSpecks, parseSpecks, proofCost, proofFees, shortAddress } from "../src/costs";

const ADDRESS = `mn_dust_undeployed1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2)}`;

describe("proofCost", () => {
  it("reads the DUST an on-chain proof cost from its fee field", () => {
    const cost = proofCost({ verificationMethod: "on-chain", dustFee: "1250000000000" });
    expect(cost).toEqual({ kind: "on-chain", specks: BigInt("1250000000000") });
  });

  it("keeps a fee beyond the safe-integer range exact", () => {
    const cost = proofCost({ verificationMethod: "on-chain", dustFee: "123456789012345678901234567890" });
    expect(cost).toEqual({ kind: "on-chain", specks: BigInt("123456789012345678901234567890") });
  });

  it("does not guess at a method it does not know, with or without a fee", () => {
    expect(proofCost({ dustFee: "5" })).toEqual({ kind: "unreported" });
    expect(proofCost({ verificationMethod: "sidechain", dustFee: "5" })).toEqual({ kind: "unreported" });
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
    for (const dustFee of [12, "", "-5", "1e9", "0x10", " 7", {}, "1".repeat(41)]) {
      expect(proofCost({ verificationMethod: "on-chain", dustFee })).toEqual({ kind: "unreported" });
    }
  });
});

describe("parseSpecks", () => {
  it("reads only a decimal string", () => {
    expect(parseSpecks("0")).toBe(BigInt(0));
    expect(parseSpecks("98765432109876543210")).toBe(BigInt("98765432109876543210"));
    for (const bad of [null, undefined, 5, "", "-1", "1.5", "1e3", " 1", "many", "9".repeat(41)]) {
      expect(parseSpecks(bad)).toBeNull();
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
  it("keeps the network prefix whole and shortens the data part", () => {
    expect(shortAddress(ADDRESS)).toBe("mn_dust_undeployed1qpzr…6mua7l");
    expect(shortAddress(`mn_dust1${"q".repeat(50)}`)).toBe("mn_dust1qqqq…qqqqqq");
  });

  it("keeps a short address, or one with no separator, whole", () => {
    expect(shortAddress("mn_dust_undeployed1abcdefg")).toBe("mn_dust_undeployed1abcdefg");
    expect(shortAddress("no-separator-here")).toBe("no-separator-here");
  });
});

describe("proofFees", () => {
  const healthy = (extra: Record<string, unknown>) => ({ status: "healthy", url: "http://zkp", ...extra });

  it("names the address to sponsor and the balance, funded only with DUST behind it", () => {
    const funded = proofFees(healthy({ wallet: "ready", dust: { address: ADDRESS, balance: "1250" } }));
    expect(funded).toEqual({
      text: "Proof fees: 1,250 specks of DUST at mn_dust_undeployed1qpzr…6mua7l",
      title: `Sponsor proofs by designating NIGHT's DUST generation to ${ADDRESS}; whether the balance covers a proof's fee is decided at proof time`,
      funded: true,
    });
    expect(proofFees(healthy({ dust: { address: ADDRESS, balance: "0" } })).funded).toBe(false);
    const unread = proofFees(healthy({ dust: { address: ADDRESS, balance: null } }));
    expect(unread.text).toBe("Proof fees: balance unknown at mn_dust_undeployed1qpzr…6mua7l");
    expect(unread.funded).toBe(false);
  });

  it("says proofs are free when the service runs offline, whatever DUST it reports", () => {
    const offline = proofFees(healthy({ wallet: "offline", dust: null }));
    expect(offline.text).toBe("Proof fees: none, proofs run offline");
    expect(offline.funded).toBe(true);
    const stale = proofFees(healthy({ wallet: "offline", dust: { address: ADDRESS, balance: "0" } }));
    expect(stale.funded).toBe(true);
  });

  it("tells a wallet that is starting or failed from one the service never mentioned", () => {
    expect(proofFees(healthy({ wallet: "starting" })).text).toBe("Proof fees: service wallet starting");
    expect(proofFees(healthy({ wallet: "failed" })).text).toBe("Proof fees: service wallet failed to start");
    expect(proofFees(healthy({ wallet: "ready", dust: null })).text).toBe(
      "Proof fees: no sponsor address reported",
    );
    expect(proofFees(healthy({})).text).toBe("Proof fees: not reported");
    expect(proofFees(healthy({ dust: { address: 7 } })).text).toBe("Proof fees: not reported");
  });

  it("reports an unreachable service rather than a missing wallet", () => {
    const down = proofFees({ status: "unavailable", url: "http://zkp", error: "refused" });
    expect(down).toEqual({ text: "Proof fees: proof service unreachable", title: "", funded: false });
    expect(proofFees(undefined).funded).toBe(false);
  });
});
