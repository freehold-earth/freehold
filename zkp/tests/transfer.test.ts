import { describe, it, expect, vi } from "vitest";
import {
  deriveKeys,
  formatNightAddress,
  type ManagedWallet,
  parseNightAddress,
  transferNight,
} from "../sdk/src/midnight/wallet.js";

const NIGHT_EXTERNAL_ROLE = 0;
const nightKey = deriveKeys("0123456789abcdef".repeat(4)).keys[NIGHT_EXTERNAL_ROLE];

describe("transferNight", () => {
  it("builds, balances with DUST, signs, finalises and submits an unshielded transfer", async () => {
    const to = formatNightAddress("standalone", nightKey);
    const facade = {
      transferTransaction: vi.fn(async () => ({ type: "UNPROVEN_TRANSACTION", transaction: "transfer" })),
      balanceUnprovenTransaction: vi.fn(async () => ({ type: "UNPROVEN_TRANSACTION", transaction: "balanced" })),
      signRecipe: vi.fn(async (recipe: unknown) => ({ signed: recipe })),
      finalizeRecipe: vi.fn(async () => "finalized"),
      submitTransaction: vi.fn(async () => "tx-9"),
    };
    const wallet = {
      facade,
      network: "standalone",
      zswapSecretKeys: { kind: "zswap" },
      dustSecretKey: { kind: "dust" },
      unshieldedKeystore: { signData: vi.fn(() => "sig") },
    } as unknown as ManagedWallet;

    expect(await transferNight(wallet, to, 5_000_000n)).toBe("tx-9");

    const [outputs, secrets, options] = facade.transferTransaction.mock.calls[0];
    expect(outputs).toHaveLength(1);
    expect(outputs[0].type).toBe("unshielded");
    expect(outputs[0].outputs[0].amount).toBe(5_000_000n);
    expect(outputs[0].outputs[0].receiverAddress.equals(parseNightAddress(to, "standalone"))).toBe(true);
    expect(secrets).toEqual({ shieldedSecretKeys: { kind: "zswap" }, dustSecretKey: { kind: "dust" } });
    expect(options).toMatchObject({ payFees: false });
    expect(facade.balanceUnprovenTransaction.mock.calls[0][0]).toBe("transfer");
    expect(facade.balanceUnprovenTransaction.mock.calls[0][2]).toMatchObject({ tokenKindsToBalance: ["dust"] });
    expect(facade.signRecipe.mock.calls[0][0]).toEqual({ type: "UNPROVEN_TRANSACTION", transaction: "balanced" });
    expect(facade.finalizeRecipe.mock.calls[0][0]).toEqual({ signed: { type: "UNPROVEN_TRANSACTION", transaction: "balanced" } });
  });

  it("refuses an address for another network or that is not an unshielded address", async () => {
    const wallet = { network: "standalone", facade: {} } as unknown as ManagedWallet;
    const testnet = formatNightAddress("testnet", nightKey);
    expect(testnet).toMatch(/^mn_addr_testnet1/);
    await expect(transferNight(wallet, testnet, 1n)).rejects.toThrow(/Expected undeployed address/);
    await expect(transferNight(wallet, "mn_dust_undeployed1abc", 1n)).rejects.toThrow();
  });
});
