import { describe, it, expect, vi } from "vitest";
import { readdirSync } from "node:fs";
import { PasswordValidationError, validatePassword } from "@midnight-ntwrk/midnight-js-utils";
import { storagePassword, withEphemeralPrivateState } from "../sdk/src/midnight/private-state.js";

const PRIVATE_STATE_ID = "ageVerificationPrivateState";
const CONTRACT_ADDRESS = "00".repeat(32);
/** A signing key as the provider stores one: a Schnorr key of 32 bytes, in hex. */
const signingKey = (hexDigit = "5") => ({ tag: "schnorr" as const, value: hexDigit.repeat(64) });

describe("storagePassword", () => {
  it("always satisfies the provider's password policy", () => {
    const samples = Array.from({ length: 5000 }, storagePassword);
    for (const sample of samples) {
      expect(() => validatePassword(sample)).not.toThrow();
    }
    expect(new Set(samples).size).toBe(samples.length);
  });

  it("replaces a UUID, which the policy can reject", () => {
    expect(() => validatePassword("1111c0de-aaaa-4bbb-8ccc-ddddeeeeffff")).toThrow(
      PasswordValidationError,
    );
    expect(() => validatePassword("deadbeef-1234-4bbb-8ccc-0a1b2c3d4e5f")).toThrow(
      PasswordValidationError,
    );
  });
});

describe("withEphemeralPrivateState", () => {
  it("round-trips state without touching the working directory", async () => {
    const cwdBefore = readdirSync(process.cwd()).sort();

    const result = await withEphemeralPrivateState(async (provider) => {
      const states = provider.forContract(CONTRACT_ADDRESS);
      await states.set(PRIVATE_STATE_ID, { n: 1 });
      await provider.setSigningKey(CONTRACT_ADDRESS, signingKey());
      return [await states.get(PRIVATE_STATE_ID), await provider.getSigningKey(CONTRACT_ADDRESS)];
    });

    expect(result).toEqual([{ n: 1 }, signingKey()]);
    expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
  });

  it("keeps nothing from one call for the next", async () => {
    await withEphemeralPrivateState(async (provider) => {
      const states = provider.forContract(CONTRACT_ADDRESS);
      await states.set(PRIVATE_STATE_ID, { n: 1 });
      await provider.setSigningKey(CONTRACT_ADDRESS, signingKey());
    });

    const result = await withEphemeralPrivateState(async (provider) => {
      const states = provider.forContract(CONTRACT_ADDRESS);
      return [await states.get(PRIVATE_STATE_ID), await provider.getSigningKey(CONTRACT_ADDRESS)];
    });

    expect(result).toEqual([null, null]);
  });

  it("keeps concurrent calls apart", async () => {
    const results = await Promise.all(
      ["a", "b", "c"].map((tag) =>
        withEphemeralPrivateState(async (provider) => {
          const states = provider.forContract(CONTRACT_ADDRESS);
          await states.set(PRIVATE_STATE_ID, { tag });
          await provider.setSigningKey(CONTRACT_ADDRESS, signingKey(tag));
          return [await states.get(PRIVATE_STATE_ID), await provider.getSigningKey(CONTRACT_ADDRESS)];
        }),
      ),
    );

    expect(results).toEqual([
      [{ tag: "a" }, signingKey("a")],
      [{ tag: "b" }, signingKey("b")],
      [{ tag: "c" }, signingKey("c")],
    ]);
  });

  it("propagates the call's error", async () => {
    await expect(
      withEphemeralPrivateState(async (provider) => {
        const states = provider.forContract(CONTRACT_ADDRESS);
        await states.set(PRIVATE_STATE_ID, {});
        throw new Error("deploy failed");
      }),
    ).rejects.toThrow("deploy failed");
  });

  it("drops the provider's cache entry whether the call succeeds or fails", async () => {
    // The level provider carries invalidateEncryptionCache beyond the
    // PrivateStateProvider interface the callback is typed against.
    type Invalidating = { invalidateEncryptionCache(): Promise<void> };
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    const watch = (provider: unknown) => {
      spies.push(vi.spyOn(provider as Invalidating, "invalidateEncryptionCache"));
    };

    await withEphemeralPrivateState(async (provider) => {
      watch(provider);
    });
    await expect(
      withEphemeralPrivateState(async (provider) => {
        watch(provider);
        throw new Error("deploy failed");
      }),
    ).rejects.toThrow("deploy failed");

    expect(spies).toHaveLength(2);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
