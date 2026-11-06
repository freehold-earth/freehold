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
import { AgeVerification } from "../../sdk/src/proofs/age-verification.js";
import { initializeClient, getClientState } from "../../sdk/src/midnight/client.js";
import { destroyWallet, getOrCreateWallet } from "../../sdk/src/midnight/wallet.js";
import { isOnChainProof } from "../../sdk/src/types.js";
import { INDEXER_URL, NODE_URL, PROOF_SERVER_URL, WALLET_SYNC_MS, live, stackIsUp } from "./stack.js";

describe("Midnight Network Integration", () => {
  let isNetworkUp = false;

  beforeAll(async () => {
    isNetworkUp = await stackIsUp();
    if (isNetworkUp) {
      // The process holds one wallet; a fresh node syncs it from genesis in
      // longer than a proof waits, so it is synced here, once.
      const wallet = await getOrCreateWallet(new AgeVerification(live).walletConfig());
      await wallet.waitForSync(WALLET_SYNC_MS);
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
        nodeUrl: NODE_URL,
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
