import { describe, it, expect, beforeAll } from "vitest";
import { SPALEnforcer } from "../src/validators/spal-enforcer.js";
import type { SPALPolicy, ValidationRequest, PaymentCurrency } from "../src/types.js";
import {
  validatePaymentCurrency,
  isAda,
  isNativeToken,
  assertNeverCurrency,
} from "../src/types.js";

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
    paymentCurrency: { kind: "Ada" },
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

    it("should reject insufficient payment (Ada)", async () => {
      const policyWithPayment: SPALPolicy = {
        ...testPolicy,
        minPayment: 1_000_000n, // 1 ADA
      };

      const result = await enforcer.validate(policyWithPayment, validRequest);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Insufficient payment");
      expect(result.error).toContain("lovelace");
    });

    it("should accept valid payment (Ada)", async () => {
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

    it("should reject insufficient payment (NativeToken)", async () => {
      const policyWithToken: SPALPolicy = {
        ...testPolicy,
        minPayment: 5_000_000n, // 5 USDCx (6 decimals)
        paymentCurrency: {
          kind: "NativeToken",
          policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
          assetName: "5553444378",
        },
      };

      const result = await enforcer.validate(policyWithToken, validRequest);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Insufficient payment");
      expect(result.error).toContain("token units");
    });

    it("should accept valid payment (NativeToken)", async () => {
      const policyWithToken: SPALPolicy = {
        ...testPolicy,
        minPayment: 5_000_000n, // 5 USDCx
        paymentCurrency: {
          kind: "NativeToken",
          policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
          assetName: "5553444378",
        },
      };

      const requestWithPayment: ValidationRequest = {
        ...validRequest,
        paymentAmount: 5_000_000n,
      };

      const result = await enforcer.validate(policyWithToken, requestWithPayment);
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

describe("validatePaymentCurrency", () => {
  it("should accept valid Ada currency", () => {
    expect(() => validatePaymentCurrency({ kind: "Ada" })).not.toThrow();
  });

  it("should accept valid NativeToken with 56-char policyId", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
        assetName: "5553444378",
      })
    ).not.toThrow();
  });

  it("should accept NativeToken with empty assetName", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
        assetName: "",
      })
    ).not.toThrow();
  });

  it("should reject NativeToken with empty policyId", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "",
        assetName: "5553444378",
      })
    ).toThrow("Invalid policyId");
  });

  it("should reject NativeToken with short policyId", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "aabb0011",
        assetName: "5553444378",
      })
    ).toThrow("Invalid policyId");
  });

  it("should reject NativeToken with non-hex policyId", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "gggg00112233445566778899aabbccddeeff00112233445566778899",
        assetName: "5553444378",
      })
    ).toThrow("Invalid policyId");
  });

  it("should reject NativeToken with oversized assetName (>64 hex chars)", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
        assetName: "aa".repeat(33), // 66 hex chars = 33 bytes, exceeds 32-byte limit
      })
    ).toThrow("Invalid assetName");
  });

  it("should reject NativeToken with odd-length assetName", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
        assetName: "abc", // odd length
      })
    ).toThrow("Invalid assetName");
  });

  it("should reject NativeToken with non-hex assetName", () => {
    expect(() =>
      validatePaymentCurrency({
        kind: "NativeToken",
        policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
        assetName: "USDCx",
      })
    ).toThrow("Invalid assetName");
  });
});

describe("PaymentCurrency type guards", () => {
  it("isAda should return true for Ada", () => {
    const c: PaymentCurrency = { kind: "Ada" };
    expect(isAda(c)).toBe(true);
    expect(isNativeToken(c)).toBe(false);
  });

  it("isNativeToken should return true for NativeToken", () => {
    const c: PaymentCurrency = {
      kind: "NativeToken",
      policyId: "aabb00112233445566778899aabbccddeeff00112233445566778899",
      assetName: "5553444378",
    };
    expect(isNativeToken(c)).toBe(true);
    expect(isAda(c)).toBe(false);
  });

  it("assertNeverCurrency should throw for unknown variant", () => {
    const bogus = { kind: "Unknown" } as never;
    expect(() => assertNeverCurrency(bogus)).toThrow("Unexpected PaymentCurrency");
  });
});
