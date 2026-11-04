import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { withEphemeralPrivateState } from "../sdk/src/midnight/private-state.js";

const PRIVATE_STATE_ID = "ageVerificationPrivateState";
const CONTRACT_ADDRESS = "00".repeat(32);

describe("withEphemeralPrivateState", () => {
  it("round-trips state without touching the working directory", async () => {
    const cwdBefore = readdirSync(process.cwd()).sort();

    const result = await withEphemeralPrivateState(async (provider) => {
      provider.setContractAddress(CONTRACT_ADDRESS);
      await provider.set(PRIVATE_STATE_ID, { n: 1 });
      await provider.setSigningKey(CONTRACT_ADDRESS, "key");
      return [await provider.get(PRIVATE_STATE_ID), await provider.getSigningKey(CONTRACT_ADDRESS)];
    });

    expect(result).toEqual([{ n: 1 }, "key"]);
    expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
  });

  it("keeps nothing from one call for the next", async () => {
    await withEphemeralPrivateState(async (provider) => {
      provider.setContractAddress(CONTRACT_ADDRESS);
      await provider.set(PRIVATE_STATE_ID, { n: 1 });
      await provider.setSigningKey(CONTRACT_ADDRESS, "key");
    });

    const result = await withEphemeralPrivateState(async (provider) => {
      provider.setContractAddress(CONTRACT_ADDRESS);
      return [await provider.get(PRIVATE_STATE_ID), await provider.getSigningKey(CONTRACT_ADDRESS)];
    });

    expect(result).toEqual([null, null]);
  });

  it("keeps concurrent calls apart", async () => {
    const results = await Promise.all(
      ["a", "b", "c"].map((tag) =>
        withEphemeralPrivateState(async (provider) => {
          provider.setContractAddress(CONTRACT_ADDRESS);
          await provider.set(PRIVATE_STATE_ID, { tag });
          await provider.setSigningKey(CONTRACT_ADDRESS, `key-${tag}`);
          return [await provider.get(PRIVATE_STATE_ID), await provider.getSigningKey(CONTRACT_ADDRESS)];
        }),
      ),
    );

    expect(results).toEqual([
      [{ tag: "a" }, "key-a"],
      [{ tag: "b" }, "key-b"],
      [{ tag: "c" }, "key-c"],
    ]);
  });

  it("propagates the call's error", async () => {
    await expect(
      withEphemeralPrivateState(async (provider) => {
        provider.setContractAddress(CONTRACT_ADDRESS);
        await provider.set(PRIVATE_STATE_ID, {});
        throw new Error("deploy failed");
      }),
    ).rejects.toThrow("deploy failed");
  });
});
