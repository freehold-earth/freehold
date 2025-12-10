/**
 * Context Store Client with Client-Side Encryption
 *
 * All encryption/decryption happens in the browser using WebCrypto.
 * The server only sees encrypted blobs - zero knowledge of plaintext.
 */

import {
  encryptWithPassword,
  decryptWithPassword,
  serializeEncrypted,
  deserializeEncrypted,
} from "./crypto";

const CONTEXT_STORE_URL = import.meta.env.VITE_CONTEXT_STORE_URL || "http://localhost:8081";

interface StoredEntry {
  key: string;
  encrypted_data: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ContextEntry<T> {
  key: string;
  data: T;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export class ContextStoreClient {
  private userId: string;
  private password: string;

  /**
   * Create a context store client
   * @param userId - Identifies the user/device
   * @param password - Used for client-side encryption (never sent to server)
   */
  constructor(userId: string, password: string) {
    this.userId = userId;
    this.password = password;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${CONTEXT_STORE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-User-ID": this.userId,
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  /**
   * List all keys in the context store
   */
  async listKeys(): Promise<string[]> {
    const result = await this.fetch<{ keys: string[] }>("/entries");
    return result.keys;
  }

  /**
   * Get and decrypt a value from the context store
   */
  async get<T>(key: string): Promise<ContextEntry<T> | null> {
    try {
      const entry = await this.fetch<StoredEntry>(`/entries/${encodeURIComponent(key)}`);

      // Decrypt client-side
      const encrypted = deserializeEncrypted(entry.encrypted_data);
      const plaintext = await decryptWithPassword(encrypted, this.password);
      const data = JSON.parse(plaintext) as T;

      return {
        key: entry.key,
        data,
        createdAt: new Date(entry.created_at),
        updatedAt: new Date(entry.updated_at),
        version: entry.version,
      };
    } catch (e) {
      // Handle 404 - entry doesn't exist yet
      if (e instanceof Error && (e.message.includes("404") || e.message.toLowerCase().includes("not found"))) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Encrypt and store a value in the context store
   */
  async put<T>(key: string, data: T): Promise<ContextEntry<T>> {
    // Encrypt client-side before sending
    const plaintext = JSON.stringify(data);
    const encrypted = await encryptWithPassword(plaintext, this.password);
    const encryptedData = serializeEncrypted(encrypted);

    const entry = await this.fetch<StoredEntry>(`/entries/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_data: encryptedData }),
    });

    return {
      key: entry.key,
      data,
      createdAt: new Date(entry.created_at),
      updatedAt: new Date(entry.updated_at),
      version: entry.version,
    };
  }

  /**
   * Delete a value from the context store
   */
  async delete(key: string): Promise<boolean> {
    const result = await this.fetch<{ deleted: boolean }>(`/entries/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    return result.deleted;
  }

  /**
   * Get CRDT sync update (for syncing with other devices)
   */
  async getSyncUpdate(stateVector?: string): Promise<string> {
    const result = await this.fetch<{ update: string }>("/sync", {
      method: "POST",
      body: JSON.stringify({ state_vector: stateVector }),
    });
    return result.update;
  }

  /**
   * Apply a sync update from another device
   */
  async applySyncUpdate(update: string): Promise<void> {
    await this.fetch<{ applied: boolean }>("/sync/apply", {
      method: "POST",
      body: JSON.stringify({ update }),
    });
  }

  /**
   * Get current state vector for sync negotiation
   */
  async getStateVector(): Promise<string> {
    const result = await this.fetch<{ state_vector: string }>("/sync/state");
    return result.state_vector;
  }
}

/**
 * Create a context store client
 * The password is used for client-side encryption only - never sent to server
 */
export function createContextStore(userId: string, password: string): ContextStoreClient {
  return new ContextStoreClient(userId, password);
}
