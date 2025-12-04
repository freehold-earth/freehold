import { describe, it, expect, beforeAll } from "vitest";
import { SPALEnforcer } from "../src/validators/spal-enforcer.js";
import type { SPALPolicy, ValidationRequest } from "../src/types.js";

describe("SPALEnforcer", () => {
  let enforcer: SPALEnforcer;

  const testPolicy: SPALPolicy = {
    id: "spal:did:pci:cardano:test:health",
    ownerPkh: "abcd1234",
    maxRetention: 0,
    derivativesForbidden: true,
    requiredPayment: 0n,
  };

  const validRequest: ValidationRequest = {
    policyId: testPolicy.id,
    requesterDid: "did:pci:ephemeral:xyz789",
    contextScope: "medical/allergies",
    proofs: [
      {
        type: "zkp",
        claim: "is_licensed_provider",
        proof: "proof_data_here",
        verificationKey: "vk_here",
      },
    ],
  };

  beforeAll(async () => {
    // Note: This test may fail if Helios is not properly installed
    // In CI, you might need to mock the compilation
    try {
      enforcer = await SPALEnforcer.create();
    } catch {
      // Create with mock script for testing
      enforcer = new SPALEnforcer({
        cborHex: "mock_cbor",
        hash: "mock_hash",
      });
    }
  });

  describe("validation", () => {
    it("should accept valid ephemeral DID", async () => {
      const result = await enforcer.validate(testPolicy, validRequest);
      expect(result.valid).toBe(true);
    });

    it("should reject non-ephemeral DID", async () => {
      const request = {
        ...validRequest,
        requesterDid: "did:pci:persistent:abc123",
      };

      const result = await enforcer.validate(testPolicy, request);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Ephemeral DID required");
    });

    it("should reject insufficient payment", async () => {
      const policyWithPayment: SPALPolicy = {
        ...testPolicy,
        requiredPayment: 1000000n, // 1 ADA
      };

      const result = await enforcer.validate(policyWithPayment, validRequest);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Insufficient payment");
    });

    it("should accept valid payment", async () => {
      const policyWithPayment: SPALPolicy = {
        ...testPolicy,
        requiredPayment: 1000000n,
      };

      const requestWithPayment: ValidationRequest = {
        ...validRequest,
        paymentAmount: 1000000n,
      };

      const result = await enforcer.validate(policyWithPayment, requestWithPayment);
      expect(result.valid).toBe(true);
    });
  });

  describe("script properties", () => {
    it("should return script hash", () => {
      const hash = enforcer.getScriptHash();
      expect(hash).toBeDefined();
      expect(typeof hash).toBe("string");
    });

    it("should return CBOR hex", () => {
      const cbor = enforcer.getCborHex();
      expect(cbor).toBeDefined();
      expect(typeof cbor).toBe("string");
    });
  });
});
