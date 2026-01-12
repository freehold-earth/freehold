/**
 * Integration tests for S-PAL validator deployment on Yaci devnet
 *
 * Prerequisites:
 * - Start Yaci devnet: docker compose up -d
 * - Validator built: cd spal_validator && aiken build
 *
 * Run: pnpm test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { SPALEnforcer } from "../../src/validators/spal-enforcer.js";
import { selectWalletFromSeed } from "../../src/lucid/provider.js";
import type { SPALPolicy, LucidConfig } from "../../src/types.js";

const YACI_STORE_URL = process.env.YACI_STORE_URL || "http://localhost:8080";
const OGMIOS_URL = process.env.OGMIOS_URL || "http://localhost:1337";
const BLUEPRINT_PATH = "./spal_validator/plutus.json";

// Yaci devkit test mnemonic - 20 pre-funded addresses with 10k ADA each
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

describe("Devnet Deployment", () => {
  let isDevnetAvailable = false;
  let isOgmiosAvailable = false;

  beforeAll(async () => {
    // Check if devnet is running (Yaci Store API)
    try {
      const response = await fetch(`${YACI_STORE_URL}/api/v1/blocks/latest`, {
        signal: AbortSignal.timeout(5000),
      });
      isDevnetAvailable = response.ok;
    } catch {
      isDevnetAvailable = false;
    }

    // Check if ogmios is available (for Lucid operations)
    try {
      const response = await fetch(OGMIOS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "queryNetwork/tip",
          id: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });
      isOgmiosAvailable = response.ok;
    } catch {
      isOgmiosAvailable = false;
    }
  });

  describe("Prerequisites", () => {
    it("should have Aiken blueprint compiled", () => {
      expect(existsSync(BLUEPRINT_PATH)).toBe(true);
    });

    it("should have valid blueprint structure", () => {
      const content = readFileSync(BLUEPRINT_PATH, "utf-8");
      const blueprint = JSON.parse(content);

      expect(blueprint.preamble).toBeDefined();
      expect(blueprint.preamble.plutusVersion).toBe("v3");
      expect(blueprint.validators).toBeInstanceOf(Array);
      expect(blueprint.validators.length).toBeGreaterThan(0);
    });

    it("should have spend validator in blueprint", () => {
      const content = readFileSync(BLUEPRINT_PATH, "utf-8");
      const blueprint = JSON.parse(content);

      const spendValidator = blueprint.validators.find((v: { title: string }) =>
        v.title.includes("spend")
      );

      expect(spendValidator).toBeDefined();
      expect(spendValidator.compiledCode).toBeDefined();
      expect(spendValidator.hash).toBeDefined();
      expect(spendValidator.hash).toHaveLength(56); // 28 bytes hex
    });
  });

  describe("Yaci Devnet", () => {
    it("should be accessible", async () => {
      if (!isDevnetAvailable) {
        console.log("Skipping: Yaci devnet not running (docker compose up -d)");
        return;
      }

      const response = await fetch(`${YACI_STORE_URL}/api/v1/blocks/latest`);
      expect(response.ok).toBe(true);
    });

    it("should be producing blocks", async () => {
      if (!isDevnetAvailable) {
        console.log("Skipping: Yaci devnet not running");
        return;
      }

      const response = await fetch(`${YACI_STORE_URL}/api/v1/blocks/latest`);
      const block = await response.json();

      expect(block).toBeDefined();
      // Block should have a number or height
      expect(block.number ?? block.height ?? block.slot).toBeDefined();
    });

    it("should have epochs", async () => {
      if (!isDevnetAvailable) {
        console.log("Skipping: Yaci devnet not running");
        return;
      }

      const response = await fetch(`${YACI_STORE_URL}/api/v1/epochs/latest`);
      expect(response.ok).toBe(true);
    });

    it("should have ogmios available", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not running (check docker compose ports)");
        return;
      }

      const response = await fetch(OGMIOS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "queryNetwork/tip",
          id: 1,
        }),
      });
      expect(response.ok).toBe(true);
    });
  });

  describe("Validator Deployment", () => {
    let enforcer: SPALEnforcer;
    let testPolicy: SPALPolicy;

    beforeAll(async () => {
      // Initialize enforcer from blueprint
      enforcer = SPALEnforcer.fromBlueprint();

      // Create test policy
      testPolicy = {
        version: 1n,
        ownerPkh: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
        contextScope: "health.records",
        minPayment: 0n,
        requiredProofHash: "",
        identityLinkage: {
          ephemeralRequired: false,
          allowPersistent: true,
        },
        retentionHours: 24n,
      };
    });

    it("should create enforcer from blueprint", () => {
      expect(enforcer.getScriptHash()).toHaveLength(56);
      expect(enforcer.getCborHex()).toBeDefined();
    });

    it("should validate off-chain correctly", async () => {
      const request = {
        requesterDid: "did:key:z6MkTest...",
        proofReference: "",
        accessTime: Math.floor(Date.now() / 1000),
        paymentAmount: 0n,
      };

      const result = await enforcer.validate(testPolicy, request);
      expect(result.valid).toBe(true);
    });

    it.skip("should deploy validator to devnet", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not available for Lucid");
        return;
      }

      // Initialize Lucid with Yaci devnet
      const config: LucidConfig = {
        network: "Custom",
        providerUrl: OGMIOS_URL,
        networkMagic: 764824073,
      };

      await enforcer.initLucid(config);

      // Select test wallet
      selectWalletFromSeed(enforcer.getLucid(), TEST_MNEMONIC);

      // Get script address
      const scriptAddress = enforcer.getScriptAddress();
      expect(scriptAddress).toBeDefined();
      expect(scriptAddress).toContain("addr_test");

      // Note: Actual deployment requires funded wallet
      // This test verifies the infrastructure is ready
    });

    it.skip("should create test policy UTxO", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not available");
        return;
      }

      // This test would create an actual on-chain UTxO
      // Requires: initialized enforcer with funded wallet
      // const txHash = await enforcer.createPolicyUtxo(testPolicy);
      // expect(txHash).toHaveLength(64);
    });

    it.skip("should validate access request on-chain", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not available");
        return;
      }

      // This test would validate against an on-chain policy UTxO
      // Requires: policy UTxO created in previous test
      // const policyUtxos = await enforcer.findPolicyUtxos();
      // expect(policyUtxos.length).toBeGreaterThan(0);
    });
  });
});
