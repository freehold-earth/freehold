import { describe, it, expect, beforeAll } from "vitest";
import { SPALEnforcer } from "../src/validators/spal-enforcer.js";
import type { SPALPolicy, ValidationRequest } from "../src/types.js";

describe("SPALEnforcer", () => {
  let enforcer: SPALEnforcer;

  const testPolicy: SPALPolicy = {
    id: "spal:did:pci:cardano:test:health",
    ownerPkh: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    minPayment: 0n,
    maxRetentionMs: 86400000, // 1 day
    identityLinkage: {
      ephemeralRequired: true,
      proofOfRootAllowed: true,
      zkContinuityAllowed: false,
    },
    requiredProofHash: "",
    contextScope: "medical/allergies",
  };

  const validRequest: ValidationRequest = {
    requesterDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    proofReference: "",
    accessTime: Date.now(),
    paymentAmount: 0n,
  };

  beforeAll(async () => {
    // Try to create enforcer from blueprint first
    try {
      enforcer = SPALEnforcer.fromBlueprint();
    } catch {
      // Fall back to mock script for testing
      enforcer = new SPALEnforcer({
        cborHex: "mock_cbor",
        hash: "mock_hash",
      });
    }
  });

  describe("validation", () => {
    it("should accept valid ephemeral DID (did:key)", async () => {
      const result = await enforcer.validate(testPolicy, validRequest);
      expect(result.valid).toBe(true);
    });

    it("should reject non-ephemeral DID when ephemeral required", async () => {
      const request: ValidationRequest = {
        ...validRequest,
        requesterDid: "did:web:example.com:user:abc123",
      };

      const result = await enforcer.validate(testPolicy, request);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Ephemeral DID");
    });

    it("should allow any DID when ephemeral not required", async () => {
      const policyNoEphemeral: SPALPolicy = {
        ...testPolicy,
        identityLinkage: {
          ephemeralRequired: false,
          proofOfRootAllowed: true,
          zkContinuityAllowed: true,
        },
      };

      const request: ValidationRequest = {
        ...validRequest,
        requesterDid: "did:web:example.com:user:abc123",
      };

      const result = await enforcer.validate(policyNoEphemeral, request);
      expect(result.valid).toBe(true);
    });

    it("should reject insufficient payment", async () => {
      const policyWithPayment: SPALPolicy = {
        ...testPolicy,
        minPayment: 1_000_000n, // 1 ADA
      };

      const result = await enforcer.validate(policyWithPayment, validRequest);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Insufficient payment");
    });

    it("should accept valid payment", async () => {
      const policyWithPayment: SPALPolicy = {
        ...testPolicy,
        minPayment: 1_000_000n,
      };

      const requestWithPayment: ValidationRequest = {
        ...validRequest,
        paymentAmount: 1_000_000n,
      };

      const result = await enforcer.validate(policyWithPayment, requestWithPayment);
      expect(result.valid).toBe(true);
    });

    it("should reject missing proof when required", async () => {
      const policyWithProof: SPALPolicy = {
        ...testPolicy,
        requiredProofHash: "abcd1234abcd1234",
      };

      const result = await enforcer.validate(policyWithProof, validRequest);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Proof reference required");
    });

    it("should accept valid proof reference", async () => {
      const policyWithProof: SPALPolicy = {
        ...testPolicy,
        requiredProofHash: "abcd1234abcd1234",
      };

      const requestWithProof: ValidationRequest = {
        ...validRequest,
        proofReference: "proof_hash_xyz123",
      };

      const result = await enforcer.validate(policyWithProof, requestWithProof);
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
