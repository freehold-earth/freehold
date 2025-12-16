import { describe, it, expect } from "vitest";
import {
  generateDID,
  generateEphemeralDID,
  generateAuthorizedEphemeralDID,
  verifyAuthorizationRecord,
  isAuthorizationExpired,
  serializeAuthorizationRecord,
  deserializeAuthorizationRecord,
  publicKeyToDID,
  didToPublicKey,
  signWithDID,
  verifyDIDSignature,
  isValidDIDKey,
  serializeDIDKeyPair,
  deserializeDIDKeyPair,
  truncateDID,
  type AuthorizationContext,
} from "../src/did.js";

describe("DID generation", () => {
  it("generates a valid did:key", async () => {
    const keyPair = await generateDID();

    expect(keyPair.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(keyPair.publicKey).toHaveLength(32);
    expect(keyPair.privateKey).toHaveLength(32);
  });

  it("generates unique DIDs", async () => {
    const keyPair1 = await generateDID();
    const keyPair2 = await generateDID();

    expect(keyPair1.did).not.toBe(keyPair2.did);
  });

  it("generates ephemeral DIDs that are unlinkable", async () => {
    const ephemeral1 = await generateEphemeralDID();
    const ephemeral2 = await generateEphemeralDID();

    expect(ephemeral1.did).not.toBe(ephemeral2.did);
    expect(isValidDIDKey(ephemeral1.did)).toBe(true);
    expect(isValidDIDKey(ephemeral2.did)).toBe(true);
  });
});

describe("DID encoding/decoding", () => {
  it("converts public key to DID and back", async () => {
    const keyPair = await generateDID();
    const extractedKey = didToPublicKey(keyPair.did);

    expect(extractedKey).not.toBeNull();
    expect(extractedKey).toEqual(keyPair.publicKey);
  });

  it("reconstructs DID from public key", async () => {
    const keyPair = await generateDID();
    const reconstructedDID = publicKeyToDID(keyPair.publicKey);

    expect(reconstructedDID).toBe(keyPair.did);
  });

  it("returns null for invalid DID", () => {
    expect(didToPublicKey("not-a-did")).toBeNull();
    expect(didToPublicKey("did:web:example.com")).toBeNull();
    expect(didToPublicKey("did:key:invalid")).toBeNull();
  });
});

describe("DID validation", () => {
  it("validates correct did:key", async () => {
    const keyPair = await generateDID();
    expect(isValidDIDKey(keyPair.did)).toBe(true);
  });

  it("rejects invalid DIDs", () => {
    expect(isValidDIDKey("")).toBe(false);
    expect(isValidDIDKey("did:web:example.com")).toBe(false);
    expect(isValidDIDKey("did:key:abc")).toBe(false);
    expect(isValidDIDKey("did:key:z123")).toBe(false);
  });
});

describe("signing and verification", () => {
  it("signs and verifies messages", async () => {
    const keyPair = await generateDID();
    const message = new TextEncoder().encode("Hello, PCI!");

    const signature = await signWithDID(keyPair.privateKey, message);
    expect(signature).toHaveLength(64);

    const isValid = await verifyDIDSignature(
      keyPair.publicKey,
      message,
      signature
    );
    expect(isValid).toBe(true);
  });

  it("rejects invalid signatures", async () => {
    const keyPair1 = await generateDID();
    const keyPair2 = await generateDID();
    const message = new TextEncoder().encode("Hello, PCI!");

    const signature = await signWithDID(keyPair1.privateKey, message);

    // Wrong public key
    const isValid = await verifyDIDSignature(
      keyPair2.publicKey,
      message,
      signature
    );
    expect(isValid).toBe(false);
  });

  it("rejects modified messages", async () => {
    const keyPair = await generateDID();
    const message = new TextEncoder().encode("Hello, PCI!");
    const modifiedMessage = new TextEncoder().encode("Hello, PCI?");

    const signature = await signWithDID(keyPair.privateKey, message);

    const isValid = await verifyDIDSignature(
      keyPair.publicKey,
      modifiedMessage,
      signature
    );
    expect(isValid).toBe(false);
  });
});

describe("serialization", () => {
  it("serializes and deserializes keypairs", async () => {
    const keyPair = await generateDID();
    const serialized = serializeDIDKeyPair(keyPair);

    expect(serialized.did).toBe(keyPair.did);
    expect(serialized.publicKey).toHaveLength(32);
    expect(serialized.privateKey).toHaveLength(32);
    expect(serialized.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const deserialized = deserializeDIDKeyPair(serialized);
    expect(deserialized.did).toBe(keyPair.did);
    expect(deserialized.publicKey).toEqual(keyPair.publicKey);
    expect(deserialized.privateKey).toEqual(keyPair.privateKey);
  });

  it("produces JSON-serializable output", async () => {
    const keyPair = await generateDID();
    const serialized = serializeDIDKeyPair(keyPair);

    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    const deserialized = deserializeDIDKeyPair(parsed);

    expect(deserialized.did).toBe(keyPair.did);
  });
});

describe("display utilities", () => {
  it("truncates DID for display", async () => {
    const keyPair = await generateDID();
    const truncated = truncateDID(keyPair.did);

    expect(truncated).toMatch(/^did:key:z6Mk\.\.\.[\w]{4}$/);
    expect(truncated.length).toBeLessThan(keyPair.did.length);
  });

  it("does not truncate short strings", () => {
    expect(truncateDID("short")).toBe("short");
  });

  it("supports custom prefix/suffix lengths", async () => {
    const keyPair = await generateDID();
    const truncated = truncateDID(keyPair.did, 8, 8);

    expect(truncated).toMatch(/^did:key:\.\.\.[\w]{8}$/);
  });
});

describe("authorized ephemeral DIDs", () => {
  const testContext: AuthorizationContext = {
    verificationType: "age_over_18",
    verifierDid: "did:key:z6MkVerifier123",
    policyHash: "0xabc123",
  };

  it("generates authorized ephemeral DID with valid authorization record", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Age verification at Test Store",
      testContext
    );

    // Check ephemeral DID is valid
    expect(isValidDIDKey(result.ephemeral.did)).toBe(true);
    expect(result.ephemeral.did).not.toBe(rootDID.did);

    // Check authorization record
    expect(result.authorization.ephemeralDid).toBe(result.ephemeral.did);
    expect(result.authorization.rootDid).toBe(rootDID.did);
    expect(result.authorization.purpose).toBe("Age verification at Test Store");
    expect(result.authorization.context).toEqual(testContext);
    expect(result.authorization.rootSignature).toHaveLength(64);
  });

  it("creates unlinkable ephemeral DIDs", async () => {
    const rootDID = await generateDID();

    const result1 = await generateAuthorizedEphemeralDID(
      rootDID,
      "First verification",
      testContext
    );
    const result2 = await generateAuthorizedEphemeralDID(
      rootDID,
      "Second verification",
      testContext
    );

    // Different ephemeral DIDs
    expect(result1.ephemeral.did).not.toBe(result2.ephemeral.did);

    // Both have valid authorization records
    expect(await verifyAuthorizationRecord(result1.authorization)).toBe(true);
    expect(await verifyAuthorizationRecord(result2.authorization)).toBe(true);
  });

  it("supports expiry time", async () => {
    const rootDID = await generateDID();
    const expiresInMs = 3600000; // 1 hour

    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Expiring verification",
      testContext,
      expiresInMs
    );

    expect(result.authorization.expiresAt).toBeDefined();
    const expiryDate = new Date(result.authorization.expiresAt!);
    const now = new Date();
    const diff = expiryDate.getTime() - now.getTime();

    // Should be approximately 1 hour in future (within 1 second tolerance)
    expect(diff).toBeGreaterThan(3599000);
    expect(diff).toBeLessThan(3601000);
  });
});

describe("authorization record verification", () => {
  const testContext: AuthorizationContext = {
    verificationType: "employment_status",
    verifierDid: "did:key:z6MkEmployer456",
  };

  it("verifies valid authorization record", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Employment verification",
      testContext
    );

    const isValid = await verifyAuthorizationRecord(result.authorization);
    expect(isValid).toBe(true);
  });

  it("rejects tampered ephemeral DID", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Test verification",
      testContext
    );

    // Tamper with the ephemeral DID
    const tamperedRecord = {
      ...result.authorization,
      ephemeralDid: "did:key:z6MkTampered123456789",
    };

    const isValid = await verifyAuthorizationRecord(tamperedRecord);
    expect(isValid).toBe(false);
  });

  it("rejects tampered purpose", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Original purpose",
      testContext
    );

    // Tamper with the purpose
    const tamperedRecord = {
      ...result.authorization,
      purpose: "Tampered purpose",
    };

    const isValid = await verifyAuthorizationRecord(tamperedRecord);
    expect(isValid).toBe(false);
  });

  it("rejects wrong root DID", async () => {
    const rootDID1 = await generateDID();
    const rootDID2 = await generateDID();

    const result = await generateAuthorizedEphemeralDID(
      rootDID1,
      "Test verification",
      testContext
    );

    // Claim a different root DID signed this
    const tamperedRecord = {
      ...result.authorization,
      rootDid: rootDID2.did,
    };

    const isValid = await verifyAuthorizationRecord(tamperedRecord);
    expect(isValid).toBe(false);
  });

  it("rejects expired authorization", async () => {
    const rootDID = await generateDID();

    // Create with 1ms expiry (will be expired immediately)
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Quick expiry test",
      testContext,
      1
    );

    // Wait a bit for expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    const isValid = await verifyAuthorizationRecord(result.authorization);
    expect(isValid).toBe(false);
  });
});

describe("authorization expiry checking", () => {
  it("returns false for non-expired record", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Future expiry",
      { verificationType: "test" },
      3600000 // 1 hour
    );

    expect(isAuthorizationExpired(result.authorization)).toBe(false);
  });

  it("returns true for expired record", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Past expiry",
      { verificationType: "test" },
      1 // 1ms
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isAuthorizationExpired(result.authorization)).toBe(true);
  });

  it("returns false for record without expiry", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "No expiry",
      { verificationType: "test" }
      // No expiry specified
    );

    expect(isAuthorizationExpired(result.authorization)).toBe(false);
  });
});

describe("authorization record serialization", () => {
  it("serializes and deserializes authorization records", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "Serialization test",
      {
        verificationType: "test",
        verifierDid: "did:key:z6MkTest",
        metadata: { foo: "bar" },
      },
      3600000
    );

    const serialized = serializeAuthorizationRecord(result.authorization);

    // Check serialized format
    expect(serialized.ephemeralDid).toBe(result.authorization.ephemeralDid);
    expect(serialized.rootDid).toBe(result.authorization.rootDid);
    expect(serialized.rootSignature).toHaveLength(64);
    expect(Array.isArray(serialized.rootSignature)).toBe(true);

    // Deserialize and verify
    const deserialized = deserializeAuthorizationRecord(serialized);
    expect(deserialized.ephemeralDid).toBe(result.authorization.ephemeralDid);
    expect(deserialized.rootSignature).toBeInstanceOf(Uint8Array);

    // Verify deserialized record is still valid
    const isValid = await verifyAuthorizationRecord(deserialized);
    expect(isValid).toBe(true);
  });

  it("produces JSON-serializable output", async () => {
    const rootDID = await generateDID();
    const result = await generateAuthorizedEphemeralDID(
      rootDID,
      "JSON test",
      { verificationType: "json_test" }
    );

    const serialized = serializeAuthorizationRecord(result.authorization);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    const deserialized = deserializeAuthorizationRecord(parsed);

    const isValid = await verifyAuthorizationRecord(deserialized);
    expect(isValid).toBe(true);
  });
});
