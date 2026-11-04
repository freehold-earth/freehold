import { describe, it, expect, vi } from "vitest";
import { designateDust, deregisterDust, registeredNight, unregisteredNight } from "../sdk/src/midnight/dust.js";
import { deriveKeys, formatDustAddress } from "../sdk/src/midnight/wallet.js";
import type { ManagedWallet } from "../sdk/src/midnight/wallet.js";

const receiverKeys = deriveKeys("fedcba9876543210".repeat(4));
const RECEIVER = formatDustAddress("standalone", receiverKeys.dustSecretKey.publicKey);

function utxo(id: string, registeredForDustGeneration: boolean) {
  return { utxo: { id }, meta: { ctime: new Date(0), registeredForDustGeneration } } as unknown as Parameters<
    typeof unregisteredNight
  >[0][number];
}

/** A sponsor wallet whose facade records what it is asked to do and answers like a PDS would. */
function fakeSponsor(coins: ReturnType<typeof utxo>[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ method, args });
      switch (method) {
        case "waitForSyncedState":
          return { unshielded: { availableCoins: coins } };
        case "estimateRegistration":
          return {
            fee: 500n,
            dustGenerationEstimations: (args[0] as unknown[]).map(() => ({
              dust: { maxCap: 5_000n, rate: 7n, maxCapReachedAt: new Date("2026-12-01T00:00:00Z") },
            })),
          };
        case "registerNightUtxosForDustGeneration":
        case "deregisterFromDustGeneration":
          return { type: "UNPROVEN_TRANSACTION", transaction: "unproven" };
        case "finalizeRecipe":
          return "finalized";
        case "submitTransaction":
          return "tx-123";
      }
    });
  const keystore = {
    getPublicKey: () => "night-verifying-key",
    signData: vi.fn((payload: Uint8Array) => `signed:${payload.length}`),
  };
  const facade = Object.fromEntries(
    [
      "waitForSyncedState",
      "estimateRegistration",
      "registerNightUtxosForDustGeneration",
      "deregisterFromDustGeneration",
      "finalizeRecipe",
      "submitTransaction",
    ].map((m) => [m, record(m)]),
  );
  const sponsor = { facade, network: "standalone", unshieldedKeystore: keystore } as unknown as ManagedWallet;
  return { sponsor, calls, facade, keystore };
}

describe("designateDust", () => {
  it("registers the sponsor's unregistered NIGHT for the receiver and submits it", async () => {
    const coins = [utxo("a", false), utxo("b", true), utxo("c", false)];
    const { sponsor, calls, facade, keystore } = fakeSponsor(coins);

    const result = await designateDust(sponsor, RECEIVER);

    expect(calls.map((c) => c.method)).toEqual([
      "waitForSyncedState",
      "estimateRegistration",
      "registerNightUtxosForDustGeneration",
      "finalizeRecipe",
      "submitTransaction",
    ]);
    const [utxos, verifyingKey, sign, receiver] = facade.registerNightUtxosForDustGeneration.mock.calls[0];
    expect(utxos).toEqual([coins[0], coins[2]]);
    expect(verifyingKey).toBe("night-verifying-key");
    expect(receiver.equals(receiverKeys.dustSecretKey.publicKey)).toBe(true);
    expect(sign(new Uint8Array(3))).toBe("signed:3");
    expect(keystore.signData).toHaveBeenCalledTimes(1);
    expect(facade.finalizeRecipe.mock.calls[0][0]).toEqual({ type: "UNPROVEN_TRANSACTION", transaction: "unproven" });
    expect(facade.submitTransaction.mock.calls[0][0]).toBe("finalized");

    expect(result).toEqual({
      txId: "tx-123",
      utxosRegistered: 2,
      fee: 500n,
      generation: [
        { maxCap: 5_000n, rate: 7n, maxCapReachedAt: new Date("2026-12-01T00:00:00Z") },
        { maxCap: 5_000n, rate: 7n, maxCapReachedAt: new Date("2026-12-01T00:00:00Z") },
      ],
    });
  });

  it("registers only the UTXOs named", async () => {
    const coins = [utxo("a", false), utxo("c", false)];
    const { sponsor, facade } = fakeSponsor(coins);
    await designateDust(sponsor, RECEIVER, { utxos: [coins[1]] });
    expect(facade.registerNightUtxosForDustGeneration.mock.calls[0][0]).toEqual([coins[1]]);
  });

  it("refuses when there is nothing to register", async () => {
    const { sponsor, calls } = fakeSponsor([utxo("b", true)]);
    await expect(designateDust(sponsor, RECEIVER)).rejects.toThrow(/no NIGHT that is not already registered/);
    expect(calls.map((c) => c.method)).toEqual(["waitForSyncedState"]);
  });

  it("refuses a receiver that is not a DUST address for this network, before touching the wallet", async () => {
    const { sponsor, calls } = fakeSponsor([utxo("a", false)]);
    const testnet = formatDustAddress("testnet", receiverKeys.dustSecretKey.publicKey);
    await expect(designateDust(sponsor, testnet)).rejects.toThrow(/Expected undeployed address/);
    await expect(designateDust(sponsor, "mn_shield-addr_undeployed1abc")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("deregisterDust", () => {
  it("deregisters the sponsor's registered NIGHT", async () => {
    const coins = [utxo("a", false), utxo("b", true)];
    const { sponsor, calls, facade } = fakeSponsor(coins);
    const result = await deregisterDust(sponsor);
    expect(calls.map((c) => c.method)).toEqual([
      "waitForSyncedState",
      "deregisterFromDustGeneration",
      "finalizeRecipe",
      "submitTransaction",
    ]);
    expect(facade.deregisterFromDustGeneration.mock.calls[0][0]).toEqual([coins[1]]);
    expect(result).toEqual({ txId: "tx-123", utxosDeregistered: 1 });
  });

  it("refuses when nothing is registered", async () => {
    const { sponsor } = fakeSponsor([utxo("a", false)]);
    await expect(deregisterDust(sponsor)).rejects.toThrow(/no NIGHT registered/);
  });
});

describe("NIGHT selection", () => {
  it("splits UTXOs by registration flag", () => {
    const coins = [utxo("a", false), utxo("b", true)];
    expect(unregisteredNight(coins)).toEqual([coins[0]]);
    expect(registeredNight(coins)).toEqual([coins[1]]);
  });
});
