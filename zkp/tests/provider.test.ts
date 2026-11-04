import { describe, it, expect, vi } from "vitest";
import {
  createWalletAndMidnightProvider,
  DustCapacityError,
  type ManagedWallet,
} from "../sdk/src/midnight/wallet.js";

const ADDRESS = "mn_dust_undeployed1service";

function fakeWallet(balance: bigint, fee: bigint) {
  const facade = {
    waitForSyncedState: vi.fn(async () => ({
      shielded: {
        coinPublicKey: { toHexString: () => "coin-pk" },
        encryptionPublicKey: { toHexString: () => "enc-pk" },
      },
    })),
    estimateTransactionFee: vi.fn(async () => fee),
    balanceUnboundTransaction: vi.fn(async () => ({ type: "UNBOUND_TRANSACTION" })),
    signRecipe: vi.fn(async (recipe: unknown) => ({ signed: recipe })),
    finalizeRecipe: vi.fn(async () => "finalized"),
    submitTransaction: vi.fn(async () => "tx-1"),
  };
  const wallet = {
    facade,
    dustAddress: ADDRESS,
    dustBalance: vi.fn(async () => balance),
    dustSecretKey: { kind: "dust" },
    zswapSecretKeys: { kind: "zswap" },
    unshieldedKeystore: { signData: () => "sig" },
  } as unknown as ManagedWallet;
  return { wallet, facade };
}

describe("the proof providers' DUST capacity check", () => {
  it("balances, signs and finalises when the wallet can pay, recording the fee", async () => {
    const { wallet, facade } = fakeWallet(2_000n, 500n);
    const providers = await createWalletAndMidnightProvider(wallet);

    expect(providers.getCoinPublicKey()).toBe("coin-pk");
    expect(providers.getEncryptionPublicKey()).toBe("enc-pk");

    const tx = { kind: "unbound" } as never;
    expect(await providers.balanceTx(tx)).toBe("finalized");
    expect(await providers.balanceTx(tx)).toBe("finalized");
    expect(providers.dustFees).toEqual([500n, 500n]);
    expect(facade.estimateTransactionFee).toHaveBeenCalledWith(
      tx,
      wallet.dustSecretKey,
      expect.objectContaining({ ttl: expect.any(Date) }),
    );
    expect(facade.balanceUnboundTransaction).toHaveBeenCalledTimes(2);
    expect(facade.signRecipe).toHaveBeenCalledTimes(2);
    expect(await providers.submitTx("finalized" as never)).toBe("tx-1");
  });

  it("refuses to balance a transaction the wallet cannot pay for, naming the address to sponsor", async () => {
    const { wallet, facade } = fakeWallet(100n, 500n);
    const providers = await createWalletAndMidnightProvider(wallet);

    const attempt = providers.balanceTx({} as never);
    await expect(attempt).rejects.toBeInstanceOf(DustCapacityError);
    await expect(attempt).rejects.toMatchObject({
      dustAddress: ADDRESS,
      available: 100n,
      required: 500n,
      message: expect.stringContaining(ADDRESS),
    });
    expect(facade.balanceUnboundTransaction).not.toHaveBeenCalled();
    expect(providers.dustFees).toEqual([]);
  });

  it("does not record a fee for a transaction that failed to finalise", async () => {
    const { wallet, facade } = fakeWallet(2_000n, 500n);
    facade.finalizeRecipe.mockRejectedValueOnce(new Error("proof server down"));
    const providers = await createWalletAndMidnightProvider(wallet);
    await expect(providers.balanceTx({} as never)).rejects.toThrow("proof server down");
    expect(providers.dustFees).toEqual([]);
  });
});

describe("DustCapacityError", () => {
  it("describes an empty wallet and a short one differently", () => {
    expect(new DustCapacityError(ADDRESS, 0n).message).toMatch(/holds no DUST.*sponsor DUST generation to mn_dust_undeployed1service/);
    expect(new DustCapacityError(ADDRESS, 10n, 25n).message).toMatch(/holds 10 specks.*needs 25/);
    expect(new DustCapacityError(ADDRESS, 0n).name).toBe("DustCapacityError");
  });
});
