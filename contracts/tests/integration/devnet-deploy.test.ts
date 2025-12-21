/**
 * Integration tests for S-PAL validator deployment on Yaci devnet
 *
 * Prerequisites:
 * - Yaci devnet running: cd pci-demo && docker compose up -d
 * - Validator built: cd spal_validator && aiken build
 *
 * Run: pnpm test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const YACI_STORE_URL = process.env.YACI_STORE_URL || "http://localhost:8080";
const BLUEPRINT_PATH = "./spal_validator/plutus.json";

describe("Devnet Deployment", () => {
  let isDevnetAvailable = false;

  beforeAll(async () => {
    // Check if devnet is running
    try {
      const response = await fetch(`${YACI_STORE_URL}/api/v1/blocks/latest`, {
        signal: AbortSignal.timeout(5000),
      });
      isDevnetAvailable = response.ok;
    } catch {
      isDevnetAvailable = false;
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
        console.log("Skipping: Yaci devnet not running");
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
  });

  describe("Validator Deployment", () => {
    it.skip("should deploy validator to devnet", async () => {
      // TODO: Implement actual deployment test
      // This requires:
      // 1. Lucid/Kupmios connection to devnet
      // 2. Funded wallet
      // 3. Reference script creation
      expect(true).toBe(true);
    });

    it.skip("should create test policy UTxO", async () => {
      // TODO: Implement policy creation test
      expect(true).toBe(true);
    });

    it.skip("should validate access request", async () => {
      // TODO: Implement validation test
      expect(true).toBe(true);
    });
  });
});
