import { Data, Effect } from "effect";
import { beforeAll, describe, it, expect, vi } from "vitest";
import { LedgerTransaction, type FinalizedTx, type UnboundTx } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnightntwrk/wallet-sdk/ledger/v9";
import {
  createWalletAndMidnightProvider,
  DustCapacityError,
  type ManagedWallet,
} from "../sdk/src/midnight/wallet.js";

const ADDRESS = "mn_dust_undeployed1service";

// Midnight.js only passes on handles of real Ledger 9 transactions, so the
// test makes one: an empty intent needs no proof, and so no proof server.
let unbound: UnboundTx;
let finalized: FinalizedTx;
let finalizedBytes: Uint8Array;

beforeAll(async () => {
  const intent = ledger.Intent.new(new Date(Date.now() + 60_000));
  const proven = await ledger.Transaction.fromParts("undeployed", undefined, undefined, intent).prove(
    { check: async () => [], prove: async () => new Uint8Array(0), lookupKey: async () => undefined },
    ledger.LedgerParameters.initialParameters().transactionCostModel.runtimeCostModel,
  );
  unbound = LedgerTransaction.seal("v9", "Unbound", proven);
  finalized = LedgerTransaction.seal("v9", "Finalized", proven.bind());
  finalizedBytes = finalized.serialize();
});

function fakeWallet(balance: bigint, fee: bigint) {
  const facade = {
    // The wallet's own handle for a transaction that reached it as bytes
    adoptTransaction: vi.fn((bytes: Uint8Array, stage: string) => ({ stage, bytes })),
    waitForSyncedState: vi.fn(async () => ({
      shielded: {
        coinPublicKey: { toHexString: () => "coin-pk" },
        encryptionPublicKey: { toHexString: () => "enc-pk" },
      },
    })),
    estimateTransactionFee: vi.fn(async () => fee),
    balanceUnboundTransaction: vi.fn(async () => ({ type: "UNBOUND_TRANSACTION" })),
    signRecipe: vi.fn(async (recipe: unknown) => ({ signed: recipe })),
    finalizeRecipe: vi.fn(async () => ({ serialize: () => finalizedBytes })),
    submitTransaction: vi.fn(async () => "tx-1"),
  };
  const wallet = {
    facade,
    dustAddress: ADDRESS,
    dustBalance: vi.fn(async () => balance),
    unshieldedKeystore: { signDataAsync: async () => "sig" },
  } as unknown as ManagedWallet;
  return { wallet, facade };
}

describe("the proof providers' DUST capacity check", () => {
  it("balances, signs and finalises when the wallet can pay, recording the fee", async () => {
    const { wallet, facade } = fakeWallet(2_000n, 500n);
    const providers = await createWalletAndMidnightProvider(wallet);

    expect(providers.getCoinPublicKey()).toBe("coin-pk");
    expect(providers.getEncryptionPublicKey()).toBe("enc-pk");

    expect(providers.supportedEras).toEqual(["v9"]);
    const balanced = await providers.balanceTx(unbound);
    expect(balanced.stage).toBe("Finalized");
    expect(balanced.era).toBe("v9");
    expect(balanced.serialize()).toEqual(finalizedBytes);
    expect((await providers.balanceTx(unbound)).serialize()).toEqual(finalizedBytes);
    expect(providers.dustFees).toEqual([500n, 500n]);
    const adopted = { stage: "Unbound", bytes: unbound.serialize() };
    expect(facade.estimateTransactionFee).toHaveBeenCalledWith(
      adopted,
      expect.objectContaining({ ttl: expect.any(Date) }),
    );
    expect(facade.balanceUnboundTransaction).toHaveBeenCalledTimes(2);
    expect(facade.balanceUnboundTransaction).toHaveBeenCalledWith(
      adopted,
      expect.objectContaining({ ttl: expect.any(Date) }),
    );
    expect(facade.signRecipe).toHaveBeenCalledTimes(2);
    expect(facade.signRecipe).toHaveBeenCalledWith(
      { type: "UNBOUND_TRANSACTION" },
      wallet.unshieldedKeystore.signDataAsync,
    );
    expect(await providers.submitTx(finalized)).toBe("tx-1");
    expect(facade.submitTransaction).toHaveBeenCalledWith({ stage: "Finalized", bytes: finalizedBytes });
  });

  it("refuses to balance a transaction the wallet cannot pay for, naming the address to sponsor", async () => {
    const { wallet, facade } = fakeWallet(100n, 500n);
    const providers = await createWalletAndMidnightProvider(wallet);

    const attempt = providers.balanceTx(unbound);
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

  it("reports the SDK's own refusal to balance as a capacity error", async () => {
    const { wallet, facade } = fakeWallet(100n, 500n);
    facade.estimateTransactionFee.mockRejectedValueOnce({ _tag: "Wallet.InsufficientFunds" });
    const providers = await createWalletAndMidnightProvider(wallet);
    const attempt = providers.balanceTx(unbound);
    await expect(attempt).rejects.toBeInstanceOf(DustCapacityError);
    await expect(attempt).rejects.toMatchObject({ dustAddress: ADDRESS, available: 100n, required: undefined });
    expect(facade.balanceUnboundTransaction).not.toHaveBeenCalled();

    facade.estimateTransactionFee.mockRejectedValueOnce(new Error("indexer unreachable"));
    await expect(providers.balanceTx(unbound)).rejects.toThrow("indexer unreachable");

    facade.balanceUnboundTransaction.mockRejectedValueOnce({ _tag: "Wallet.InsufficientFunds" });
    const { wallet: rich } = fakeWallet(2_000n, 500n);
    const richProviders = await createWalletAndMidnightProvider(rich);
    (rich.facade.balanceUnboundTransaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      _tag: "Wallet.InsufficientFunds",
    });
    await expect(richProviders.balanceTx(unbound)).rejects.toMatchObject({ available: 2_000n, required: 500n });
  });

  it("recognises the refusal as the wallet SDK really delivers it", async () => {
    // The SDK runs on Effect, and a failed Effect run as a promise rejects
    // with a wrapper around the failure: the tag is not on the error itself.
    class InsufficientFunds extends Data.TaggedError("Wallet.InsufficientFunds")<{ message: string }> {}
    const refusal = await Effect.runPromise(Effect.fail(new InsufficientFunds({ message: "no dust" }))).catch(
      (err: unknown) => err,
    );
    expect((refusal as { _tag?: unknown })._tag).toBeUndefined();

    const { wallet, facade } = fakeWallet(100n, 500n);
    facade.estimateTransactionFee.mockRejectedValueOnce(refusal);
    const providers = await createWalletAndMidnightProvider(wallet);
    await expect(providers.balanceTx(unbound)).rejects.toBeInstanceOf(DustCapacityError);

    // A different failure in the same wrapper is not mistaken for it.
    class Other extends Data.TaggedError("Wallet.Other")<{ message: string }> {}
    const other = await Effect.runPromise(Effect.fail(new Other({ message: "x" }))).catch((err: unknown) => err);
    facade.estimateTransactionFee.mockRejectedValueOnce(other);
    await expect(providers.balanceTx(unbound)).rejects.not.toBeInstanceOf(DustCapacityError);
  });

  it("does not record a fee for a transaction that failed to finalise", async () => {
    const { wallet, facade } = fakeWallet(2_000n, 500n);
    facade.finalizeRecipe.mockRejectedValueOnce(new Error("proof server down"));
    const providers = await createWalletAndMidnightProvider(wallet);
    await expect(providers.balanceTx(unbound)).rejects.toThrow("proof server down");
    expect(providers.dustFees).toEqual([]);
  });
});

describe("DustCapacityError", () => {
  it("describes an empty wallet and a short one differently", () => {
    expect(new DustCapacityError(ADDRESS, 0n).message).toMatch(/holds no DUST.*sponsor DUST generation to mn_dust_undeployed1service/);
    expect(new DustCapacityError(ADDRESS, 10n, 25n).message).toMatch(/holds 10 specks.*needs 25/);
    expect(new DustCapacityError(ADDRESS, 10n).message).toMatch(/holds 10 specks.*cannot cover/);
    expect(new DustCapacityError(ADDRESS, 0n).name).toBe("DustCapacityError");
  });
});
