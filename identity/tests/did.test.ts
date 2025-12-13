import { describe, it, expect } from "vitest";
import {
  generateDID,
  generateEphemeralDID,
  publicKeyToDID,
  didToPublicKey,
  signWithDID,
  verifyDIDSignature,
  isValidDIDKey,
  serializeDIDKeyPair,
  deserializeDIDKeyPair,
  truncateDID,
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
