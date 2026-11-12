/**
 * Live check of DUST sponsorship against the standalone stack (#37):
 * a sponsor funded from the dev preset's genesis wallet registers its NIGHT
 * for DUST generation to a fresh service wallet's address, and the service's
 * balance rises.
 *
 * Needs `docker compose up -d node proof-server indexer` in zkp/. Skips
 * otherwise. The genesis seed is the dev preset's public one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { designateDust, registeredNight, unregisteredNight } from "../../sdk/src/midnight/dust.js";
import { createWallet, type ManagedWallet, transferNight } from "../../sdk/src/midnight/wallet.js";
import { GENESIS_SEED, INDEXER_URL, NODE_URL, PROOF_SERVER_URL, WALLET_SYNC_MS, stackIsUp } from "./stack.js";

const config = {
  network: "standalone" as const,
  indexerUrl: `${INDEXER_URL}/api/v4/graphql`,
  indexerWsUrl: `${INDEXER_URL.replace(/^http/, "ws")}/api/v4/graphql/ws`,
  nodeUrl: NODE_URL,
  proofServerUrl: PROOF_SERVER_URL,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("DUST sponsorship on the standalone network", () => {
  let isNetworkUp = false;
  const wallets: ManagedWallet[] = [];

  beforeAll(async () => {
    isNetworkUp =
      process.env.MIDNIGHT_NETWORK === undefined || process.env.MIDNIGHT_NETWORK === "standalone"
        ? await stackIsUp()
        : false;
  });

  afterAll(async () => {
    for (const wallet of wallets) await wallet.stop().catch(() => undefined);
  });

  async function synced(options = {}): Promise<ManagedWallet> {
    const wallet = await createWallet({ ...config, ...options });
    wallets.push(wallet);
    await wallet.waitForSync(WALLET_SYNC_MS);
    return wallet;
  }

  it(
    "lets a sponsor's NIGHT pay a service's DUST",
    async () => {
      if (!isNetworkUp) return;

      const genesis = await synced({ seed: GENESIS_SEED });
      const service = await synced();
      const sponsor = await synced();
      expect(service.dustAddress).toMatch(/^mn_dust_undeployed1/);
      expect(await service.dustBalance()).toBe(0n);

      // Fund the sponsor with NIGHT; genesis pays the fee in DUST
      expect(sponsor.unshieldedAddress).toMatch(/^mn_addr_undeployed1/);
      await transferNight(genesis, sponsor.unshieldedAddress, 100_000n * 1_000_000n);
      let night = unregisteredNight((await sponsor.facade.waitForSyncedState()).unshielded.availableCoins);
      for (let i = 0; night.length === 0 && i < 60; i++) {
        await sleep(5_000);
        night = unregisteredNight((await sponsor.facade.waitForSyncedState()).unshielded.availableCoins);
      }
      expect(night.length).toBeGreaterThan(0);

      // The sponsor designates its NIGHT's DUST to the service
      const sponsorship = await designateDust(sponsor, service.dustAddress, {
        waitForFeeMs: 10 * 60_000,
        pollIntervalMs: 5_000,
      });
      expect(sponsorship.utxosRegistered).toBe(night.length);
      expect(sponsorship.fee).toBeGreaterThan(0n);
      expect(sponsorship.generation[0]?.rate).toBeGreaterThan(0n);

      // The service's DUST balance rises; the sponsor's NIGHT shows as registered
      let balance = 0n;
      for (let i = 0; balance === 0n && i < 36; i++) {
        await sleep(10_000);
        balance = await service.dustBalance();
      }
      expect(balance).toBeGreaterThan(0n);
      const after = await sponsor.facade.waitForSyncedState();
      expect(registeredNight(after.unshielded.availableCoins).length).toBeGreaterThan(0);
    },
    // Above the sum of the waits inside: three syncs, the NIGHT arriving,
    // the fee generating, the balance rising
    40 * 60_000,
  );
});
