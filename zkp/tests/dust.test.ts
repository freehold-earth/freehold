import { describe, it, expect, vi } from "vitest";
import {
  designateDust,
  deregisterDust,
  DustRegistrationNotReadyError,
  type NightUtxo,
  registeredNight,
  unregisteredNight,
} from "../sdk/src/midnight/dust.js";
import { deriveKeys, formatDustAddress } from "../sdk/src/midnight/wallet.js";
import type { ManagedWallet } from "../sdk/src/midnight/wallet.js";

const receiverKeys = deriveKeys("fedcba9876543210".repeat(4));
const RECEIVER = formatDustAddress("standalone", receiverKeys.dustSecretKey.publicKey);

function utxo(id: string, registeredForDustGeneration: boolean) {
  return { utxo: { id }, meta: { ctime: new Date(0), registeredForDustGeneration } } as unknown as NightUtxo;
}

/**
 * A sponsor wallet whose facade records what it is asked to do and answers
 * like a node would. `generated` is how much DUST each UTXO has generated
 * towards the 500-speck fee, per estimate call in turn.
 */
function fakeSponsor(coins: ReturnType<typeof utxo>[], generated: bigint[] = [5_000n]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let estimates = 0;
  const record = (method: string) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ method, args });
      switch (method) {
        case "waitForSyncedState":
          return { unshielded: { availableCoins: coins } };
        case "estimateRegistration": {
          const generatedNow = generated[Math.min(estimates, generated.length - 1)];
          estimates += 1;
          return {
            fee: 500n,
            dustGenerationEstimations: (args[0] as unknown[]).map(() => ({
              dust: {
                maxCap: 5_000n,
                rate: 7n,
                generatedNow,
                maxCapReachedAt: new Date("2026-12-01T00:00:00Z"),
              },
            })),
          };
        }
        case "registerNightUtxosForDustGeneration":
        case "deregisterFromDustGeneration":
          return { type: "UNPROVEN_TRANSACTION", transaction: "unproven" };
        case "balanceUnprovenTransaction":
          return { type: "UNPROVEN_TRANSACTION", transaction: "balanced" };
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
      "balanceUnprovenTransaction",
      "finalizeRecipe",
      "submitTransaction",
    ].map((m) => [m, record(m)]),
  );
  const sponsor = {
    facade,
    network: "standalone",
    unshieldedKeystore: keystore,
    zswapSecretKeys: { kind: "zswap" },
    dustSecretKey: { kind: "dust" },
  } as unknown as ManagedWallet;
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

  it("fails at once when the NIGHT has not generated its fee and no wait is allowed", async () => {
    const { sponsor, calls } = fakeSponsor([utxo("a", false)], [100n]);
    const failure = await designateDust(sponsor, RECEIVER).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DustRegistrationNotReadyError);
    expect(failure).toMatchObject({ fee: 500n, generated: 100n, readyInSeconds: 58 });
    expect(calls.map((c) => c.method)).toEqual(["waitForSyncedState", "estimateRegistration"]);
  });

  it("waits for the fee to generate when allowed, then registers", async () => {
    const { sponsor, calls } = fakeSponsor([utxo("a", false)], [100n, 300n, 600n]);
    const result = await designateDust(sponsor, RECEIVER, { waitForFeeMs: 120_000, pollIntervalMs: 1 });
    expect(calls.filter((c) => c.method === "estimateRegistration")).toHaveLength(3);
    expect(calls.at(-1)?.method).toBe("submitTransaction");
    expect(result.utxosRegistered).toBe(1);
  });

  it("gives up waiting when the fee cannot generate within the wait allowed", async () => {
    const { sponsor } = fakeSponsor([utxo("a", false)], [100n]);
    await expect(
      designateDust(sponsor, RECEIVER, { waitForFeeMs: 1_000, pollIntervalMs: 1 }),
    ).rejects.toBeInstanceOf(DustRegistrationNotReadyError);
  });

  it("redirects registered NIGHT by balancing the registration with a DUST spend", async () => {
    const coins = [utxo("a", true), utxo("b", true)];
    const { sponsor, calls, facade } = fakeSponsor(coins, [0n]);
    const result = await designateDust(sponsor, RECEIVER, { utxos: coins });
    expect(calls.map((c) => c.method)).toEqual([
      "waitForSyncedState",
      "estimateRegistration",
      "registerNightUtxosForDustGeneration",
      "balanceUnprovenTransaction",
      "finalizeRecipe",
      "submitTransaction",
    ]);
    const [transaction, keys, opts] = facade.balanceUnprovenTransaction.mock.calls[0];
    expect(transaction).toBe("unproven");
    expect(keys).toEqual({ shieldedSecretKeys: { kind: "zswap" }, dustSecretKey: { kind: "dust" } });
    expect(opts).toMatchObject({ tokenKindsToBalance: ["dust"] });
    expect(facade.finalizeRecipe.mock.calls[0][0]).toEqual({ type: "UNPROVEN_TRANSACTION", transaction: "balanced" });
    expect(result.utxosRegistered).toBe(2);
  });

  it("registers only the UTXOs named", async () => {
    const coins = [utxo("a", false), utxo("c", false)];
    const { sponsor, facade } = fakeSponsor(coins);
    await designateDust(sponsor, RECEIVER, { utxos: [coins[1]] });
    expect(facade.registerNightUtxosForDustGeneration.mock.calls[0][0]).toEqual([coins[1]]);
  });

  it("refuses when there is nothing to register", async () => {
    const { sponsor, calls } = fakeSponsor([utxo("b", true)]);
    await expect(designateDust(sponsor, RECEIVER)).rejects.toThrow(/no NIGHT that is not already registered.*redirect/);
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
