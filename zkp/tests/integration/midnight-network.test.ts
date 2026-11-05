/**
 * Integration tests for Midnight network (Ledger 8.1.0)
 *
 * Prerequisites:
 * - Start the Midnight stack: docker compose up -d node proof-server indexer
 * - Compile the contract: cd contract && pnpm run compact
 *
 * Run: pnpm test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgeVerification } from "../../sdk/src/proofs/age-verification.js";
import { isNetworkAvailable, initializeClient, getClientState } from "../../sdk/src/midnight/client.js";
import { destroyWallet, getOrCreateWallet } from "../../sdk/src/midnight/wallet.js";
import { isOnChainProof } from "../../sdk/src/types.js";

const PROOF_SERVER_URL = process.env.MIDNIGHT_PROOF_SERVER_URL || "http://localhost:6300";
const INDEXER_URL = process.env.MIDNIGHT_INDEXER_URL || "http://localhost:8088";
const NODE_URL = process.env.MIDNIGHT_NODE_URL || "ws://localhost:9944";
// The dev preset's public genesis wallet, which already holds DUST; a fresh
// wallet has none and could pay for no proof.
const GENESIS_SEED = "0".repeat(63) + "1";

/**
 * Where `pnpm run compact` in contract/ writes the compiled circuit, which is
 * also where the SDK looks by default. A stack that is up without these
 * assets fails the suite rather than skipping it: the on-chain cases are the
 * point of running it, and they skipped unnoticed for months while the path
 * here named a directory the compiler never writes.
 */
const CONTRACT_ASSETS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "contract", "managed");
const hasContractAssets = existsSync(CONTRACT_ASSETS_PATH);

/** The service as it runs against the local stack, paying from the genesis wallet. */
const live = {
  proofServerUrl: PROOF_SERVER_URL,
  indexerUrl: INDEXER_URL,
  nodeUrl: NODE_URL,
  walletSeed: GENESIS_SEED,
  contractAssetsPath: CONTRACT_ASSETS_PATH,
};

describe("Midnight Network Integration", () => {
  let isNetworkUp = false;

  beforeAll(async () => {
    // Check if Midnight network is running
    isNetworkUp = await isNetworkAvailable({
      proofServerUrl: PROOF_SERVER_URL,
      networkCheckTimeoutMs: 5000,
    });

    if (!isNetworkUp) {
      console.log("Skipping integration tests: Midnight network not running");
      console.log("Start with: docker compose up -d node proof-server indexer");
    } else if (!hasContractAssets) {
      throw new Error(
        `The Midnight stack is up but the compiled contract is missing at ${CONTRACT_ASSETS_PATH}; run "pnpm run compact" in contract/`,
      );
    } else {
      // The process holds one wallet; a fresh node syncs it from genesis in
      // longer than a proof waits, so it is synced here, once.
      const wallet = await getOrCreateWallet(new AgeVerification(live).walletConfig());
      await wallet.waitForSync(240_000);
    }
  });

  afterAll(async () => {
    await destroyWallet();
  });

  describe("Network Connectivity", () => {
    it("should detect proof server", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const response = await fetch(`${PROOF_SERVER_URL}/health`);
      expect(response.ok).toBe(true);
    });

    it("should detect indexer", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      // Ledger 8 uses /api/v4/ paths
      const response = await fetch(`${INDEXER_URL}/api/v4/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
      expect(response.ok).toBe(true);
    });

    it("should initialize client successfully", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const connected = await initializeClient({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      expect(connected).toBe(true);

      const state = getClientState();
      expect(state.connected).toBe(true);
      expect(state.network).toBe("standalone");
      expect(state.config).toBeDefined();
    });
  });

  describe("Age Verification with Network", () => {
    it("should attempt on-chain proof when network is available", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const verifier = new AgeVerification(live);
      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.circuitId).toBe("age_verification");
      expect(isOnChainProof(proof)).toBe(true);
      if (isOnChainProof(proof)) {
        expect(proof.txId).toBeDefined();
        expect(proof.contractAddress).toBeDefined();
        expect(proof.blockHeight).toBeGreaterThan(0);
        expect(proof.publicSignals.verified).toBe(true);
      }
    });
  });

  describe("Fallback Behavior", () => {
    it("should fall back to placeholder when network unavailable", async () => {
      const verifier = new AgeVerification({
        proofServerUrl: "http://localhost:59999", // Unlikely-to-be-listening port
        networkCheckTimeoutMs: 100,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.circuitId).toBe("age_verification");
      expect(proof.publicSignals.verified).toBe(true);
      expect(proof.publicSignals.network).toBe("mocked");
      // Placeholder proofs are offline
      expect(proof.verificationMethod).toBe("offline");
    });

    it("should skip network check when configured", async () => {
      const verifier = new AgeVerification({
        forceOffline: true,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.publicSignals.network).toBe("mocked");
    });
  });

  describe("Ephemeral Contract Privacy", () => {
    it("should use different contract addresses for different verifiers", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const verifier1 = new AgeVerification(live);
      const verifier2 = new AgeVerification(live);

      const proof1 = await verifier1.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      const proof2 = await verifier2.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      // Each proof deploys a fresh ephemeral contract — addresses must differ
      expect(isOnChainProof(proof1)).toBe(true);
      expect(isOnChainProof(proof2)).toBe(true);
      if (isOnChainProof(proof1) && isOnChainProof(proof2)) {
        expect(proof1.contractAddress).not.toBe(proof2.contractAddress);
      }
    });
  });
});
