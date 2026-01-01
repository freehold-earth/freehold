/**
 * Tests for datum and redeemer builders
 *
 * These test the Plutus Data serialization without requiring Lucid or devnet.
 */

import { describe, it, expect } from "vitest";
import {
  buildPolicyDatum,
  buildAccessRedeemer,
  buildIdentityLinkage,
  parsePolicyDatum,
  parseIdentityLinkage,
  serializeDatum,
  serializeRedeemer,
  deserializeDatum,
} from "../src/lucid/datum-builders.js";
import { Data, Constr } from "@lucid-evolution/lucid";
import type { SPALPolicy, ValidationRequest, IdentityLinkage } from "../src/types.js";

describe("Datum Builders", () => {
  const testPolicy: SPALPolicy = {
    id: "spal:test:health",
    ownerPkh: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    minPayment: 1_000_000n,
    maxRetentionMs: 86400000,
    identityLinkage: {
      ephemeralRequired: true,
      proofOfRootAllowed: true,
      zkContinuityAllowed: false,
    },
    requiredProofHash: "deadbeef",
    contextScope: "medical/allergies",
  };

  const testRequest: ValidationRequest = {
    requesterDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    proofReference: "proof123abc",
    accessTime: 1704067200000,
    paymentAmount: 1_000_000n,
  };

  describe("buildIdentityLinkage", () => {
    it("should build identity linkage with all true", () => {
      const linkage: IdentityLinkage = {
        ephemeralRequired: true,
        proofOfRootAllowed: true,
        zkContinuityAllowed: true,
      };

      const result = buildIdentityLinkage(linkage);
      expect(result).toBeInstanceOf(Constr);
      expect(result.index).toBe(0);
      expect(result.fields.length).toBe(3);
    });

    it("should build identity linkage with all false", () => {
      const linkage: IdentityLinkage = {
        ephemeralRequired: false,
        proofOfRootAllowed: false,
        zkContinuityAllowed: false,
      };

      const result = buildIdentityLinkage(linkage);
      expect(result).toBeInstanceOf(Constr);
      // All bools should be Constr(0, []) for false
      for (const field of result.fields) {
        expect(field).toBeInstanceOf(Constr);
        expect((field as Constr<unknown>).index).toBe(0);
      }
    });

    it("should round-trip identity linkage through parse", () => {
      const linkage: IdentityLinkage = {
        ephemeralRequired: true,
        proofOfRootAllowed: false,
        zkContinuityAllowed: true,
      };

      const built = buildIdentityLinkage(linkage);
      const parsed = parseIdentityLinkage(built);

      expect(parsed.ephemeralRequired).toBe(linkage.ephemeralRequired);
      expect(parsed.proofOfRootAllowed).toBe(linkage.proofOfRootAllowed);
      expect(parsed.zkContinuityAllowed).toBe(linkage.zkContinuityAllowed);
    });
  });

  describe("buildPolicyDatum", () => {
    it("should build policy datum with all fields", () => {
      const result = buildPolicyDatum(testPolicy);

      expect(result).toBeInstanceOf(Constr);
      expect(result.index).toBe(0);
      expect(result.fields.length).toBe(6);
    });

    it("should include ownerPkh as first field", () => {
      const result = buildPolicyDatum(testPolicy);
      expect(result.fields[0]).toBe(testPolicy.ownerPkh);
    });

    it("should include minPayment as bigint", () => {
      const result = buildPolicyDatum(testPolicy);
      expect(result.fields[1]).toBe(testPolicy.minPayment);
    });

    it("should handle empty requiredProofHash", () => {
      const policyNoProof: SPALPolicy = {
        ...testPolicy,
        requiredProofHash: "",
      };

      const result = buildPolicyDatum(policyNoProof);
      expect(result.fields[4]).toBe("");
    });

    it("should serialize to CBOR", () => {
      const cbor = serializeDatum(testPolicy);

      expect(cbor).toBeDefined();
      expect(typeof cbor).toBe("string");
      expect(cbor.length).toBeGreaterThan(0);
    });

    it("should round-trip through serialize/deserialize", () => {
      const cbor = serializeDatum(testPolicy);
      const parsed = deserializeDatum(cbor);

      expect(parsed.ownerPkh).toBe(testPolicy.ownerPkh);
      expect(parsed.minPayment).toBe(testPolicy.minPayment);
      expect(parsed.maxRetentionMs).toBe(testPolicy.maxRetentionMs);
      expect(parsed.contextScope).toBe(testPolicy.contextScope);
      expect(parsed.identityLinkage.ephemeralRequired).toBe(
        testPolicy.identityLinkage.ephemeralRequired
      );
    });
  });

  describe("buildAccessRedeemer", () => {
    it("should build access redeemer with all fields", () => {
      const result = buildAccessRedeemer(testRequest);

      expect(result).toBeInstanceOf(Constr);
      expect(result.index).toBe(0);
      expect(result.fields.length).toBe(4);
    });

    it("should encode requesterDid as hex", () => {
      const result = buildAccessRedeemer(testRequest);
      // First field should be hex-encoded DID
      const didHex = result.fields[0] as string;
      expect(typeof didHex).toBe("string");
      // Verify it's valid hex
      expect(/^[0-9a-f]+$/i.test(didHex)).toBe(true);
    });

    it("should include payment amount", () => {
      const result = buildAccessRedeemer(testRequest);
      expect(result.fields[3]).toBe(testRequest.paymentAmount);
    });

    it("should handle empty proof reference", () => {
      const requestNoProof: ValidationRequest = {
        ...testRequest,
        proofReference: "",
      };

      const result = buildAccessRedeemer(requestNoProof);
      expect(result.fields[1]).toBe("");
    });

    it("should serialize to CBOR", () => {
      const cbor = serializeRedeemer(testRequest);

      expect(cbor).toBeDefined();
      expect(typeof cbor).toBe("string");
      expect(cbor.length).toBeGreaterThan(0);
    });
  });

  describe("CBOR serialization", () => {
    it("should produce deterministic output for same input", () => {
      const cbor1 = serializeDatum(testPolicy);
      const cbor2 = serializeDatum(testPolicy);

      expect(cbor1).toBe(cbor2);
    });

    it("should produce different output for different input", () => {
      const policy2: SPALPolicy = {
        ...testPolicy,
        minPayment: 2_000_000n,
      };

      const cbor1 = serializeDatum(testPolicy);
      const cbor2 = serializeDatum(policy2);

      expect(cbor1).not.toBe(cbor2);
    });
  });
});
