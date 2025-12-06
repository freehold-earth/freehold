import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  encryptWithPassword,
  decryptWithPassword,
  generateKey,
  deriveKey,
  clearKey,
} from "../src/crypto/index.js";

describe("Crypto", () => {
  describe("key generation", () => {
    it("should generate a 32-byte key", () => {
      const key = generateKey();
      expect(key.length).toBe(32);
    });

    it("should generate unique keys", () => {
      const key1 = generateKey();
      const key2 = generateKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe("key derivation", () => {
    it("should derive consistent key from password", () => {
      const { key: key1, salt } = deriveKey("test-password");
      const { key: key2 } = deriveKey("test-password", salt);
      expect(key1.equals(key2)).toBe(true);
    });

    it("should derive different keys for different passwords", () => {
      const { key: key1, salt } = deriveKey("password1");
      const { key: key2 } = deriveKey("password2", salt);
      expect(key1.equals(key2)).toBe(false);
    });

    it("should derive different keys with different salts", () => {
      const { key: key1 } = deriveKey("same-password");
      const { key: key2 } = deriveKey("same-password");
      // Different salts = different keys
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe("encrypt/decrypt", () => {
    it("should encrypt and decrypt a string", () => {
      const key = generateKey();
      const plaintext = "Hello, World!";

      const encrypted = encrypt(plaintext, key);
      expect(encrypted.ciphertext).not.toBe(plaintext);
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined();

      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it("should encrypt and decrypt JSON data", () => {
      const key = generateKey();
      const data = { name: "Alice", age: 30, nested: { value: true } };
      const plaintext = JSON.stringify(data);

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(JSON.parse(decrypted)).toEqual(data);
    });

    it("should encrypt and decrypt a Buffer", () => {
      const key = generateKey();
      // Use valid UTF-8 bytes for round-trip test
      const originalText = "Binary test: \u0000\u0001\u0002";
      const buffer = Buffer.from(originalText, "utf8");

      const encrypted = encrypt(buffer, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(originalText);
    });

    it("should produce different ciphertext for same plaintext", () => {
      const key = generateKey();
      const plaintext = "Same message";

      const encrypted1 = encrypt(plaintext, key);
      const encrypted2 = encrypt(plaintext, key);

      // IVs should be different
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      // Ciphertext should be different due to different IVs
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    });

    it("should fail decryption with wrong key", () => {
      const key1 = generateKey();
      const key2 = generateKey();
      const plaintext = "Secret message";

      const encrypted = encrypt(plaintext, key1);

      expect(() => decrypt(encrypted, key2)).toThrow(
        "Decryption failed: invalid key or tampered data"
      );
    });

    it("should fail decryption with tampered ciphertext", () => {
      const key = generateKey();
      const plaintext = "Secret message";

      const encrypted = encrypt(plaintext, key);
      // Tamper with the ciphertext
      const tampered = Buffer.from(encrypted.ciphertext, "base64");
      tampered[0] ^= 0xff;
      encrypted.ciphertext = tampered.toString("base64");

      expect(() => decrypt(encrypted, key)).toThrow(
        "Decryption failed: invalid key or tampered data"
      );
    });

    it("should fail decryption with tampered auth tag", () => {
      const key = generateKey();
      const plaintext = "Secret message";

      const encrypted = encrypt(plaintext, key);
      // Tamper with the auth tag
      const tampered = Buffer.from(encrypted.authTag, "base64");
      tampered[0] ^= 0xff;
      encrypted.authTag = tampered.toString("base64");

      expect(() => decrypt(encrypted, key)).toThrow(
        "Decryption failed: invalid key or tampered data"
      );
    });

    it("should reject invalid key length", () => {
      const shortKey = Buffer.alloc(16);
      const plaintext = "Test";

      expect(() => encrypt(plaintext, shortKey)).toThrow(
        "Key must be 32 bytes"
      );
    });
  });

  describe("password-based encryption", () => {
    it("should encrypt and decrypt with password", () => {
      const password = "my-secret-password";
      const plaintext = "Sensitive data";

      const encrypted = encryptWithPassword(plaintext, password);
      expect(encrypted.salt).toBeDefined();

      const decrypted = decryptWithPassword(encrypted, password);
      expect(decrypted).toBe(plaintext);
    });

    it("should fail with wrong password", () => {
      const plaintext = "Sensitive data";

      const encrypted = encryptWithPassword(plaintext, "correct-password");

      expect(() => decryptWithPassword(encrypted, "wrong-password")).toThrow(
        "Decryption failed"
      );
    });

    it("should fail if salt is missing", () => {
      const encrypted = encryptWithPassword("test", "password");
      delete encrypted.salt;

      expect(() => decryptWithPassword(encrypted, "password")).toThrow(
        "No salt found"
      );
    });
  });

  describe("clearKey", () => {
    it("should zero out the key buffer", () => {
      const key = generateKey();
      // Verify key has non-zero bytes
      expect(key.some((b) => b !== 0)).toBe(true);

      clearKey(key);

      // All bytes should now be zero
      expect(key.every((b) => b === 0)).toBe(true);
    });
  });
});
