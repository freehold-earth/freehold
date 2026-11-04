import { describe, it, expect } from "vitest";
import { deriveKeys, formatDustAddress, parseDustAddress } from "../sdk/src/midnight/wallet.js";

const seed = "0123456789abcdef".repeat(4);

describe("DUST addresses", () => {
  it("formats a key as a network-prefixed bech32m address and parses it back", () => {
    const { dustSecretKey } = deriveKeys(seed);
    const address = formatDustAddress("standalone", dustSecretKey.publicKey);
    expect(address).toMatch(/^mn_dust_undeployed1[a-z0-9]+$/);
    expect(parseDustAddress(address, "standalone").equals(dustSecretKey.publicKey)).toBe(true);
    dustSecretKey.clear();
  });

  it("carries no network segment on mainnet", () => {
    const { dustSecretKey } = deriveKeys(seed);
    expect(formatDustAddress("mainnet", dustSecretKey.publicKey)).toMatch(/^mn_dust1/);
    dustSecretKey.clear();
  });

  it("rejects an address for another network, or that is not a DUST address", () => {
    const { dustSecretKey } = deriveKeys(seed);
    const testnet = formatDustAddress("testnet", dustSecretKey.publicKey);
    expect(() => parseDustAddress(testnet, "standalone")).toThrow(/Expected undeployed address/);
    expect(() => parseDustAddress("mn_dust_undeployed1notanaddress", "standalone")).toThrow();
    expect(() => parseDustAddress("not an address", "standalone")).toThrow();
    dustSecretKey.clear();
  });
});
