/**
 * SQLite Storage Layer for PCI Context Store
 *
 * Provides persistent storage using better-sqlite3. All data is stored
 * encrypted - SQLite just provides the persistence layer.
 */

import Database from "better-sqlite3";
import type { EncryptedData } from "../crypto/index.js";

export interface StoredEntry {
  encrypted: EncryptedData;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface SQLiteStorageOptions {
  /** Path to database file. Use ":memory:" for in-memory database */
  path: string;
  /** Vault name/namespace for this storage instance */
  vaultName: string;
}

/**
 * SQLite-backed storage for encrypted vault entries
 */
export class SQLiteStorage {
  private db: Database.Database;
  private vaultName: string;
  private stmts: {
    get: Database.Statement;
    put: Database.Statement;
    delete: Database.Statement;
    keys: Database.Statement;
    has: Database.Statement;
    all: Database.Statement;
    clear: Database.Statement;
  };

  constructor(options: SQLiteStorageOptions) {
    this.vaultName = options.vaultName;
    this.db = new Database(options.path);

    // Enable WAL mode for better concurrency
    this.db.pragma("journal_mode = WAL");

    // Create table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_entries (
        vault_name TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        salt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (vault_name, entry_key)
      );

      CREATE INDEX IF NOT EXISTS idx_vault_name ON vault_entries(vault_name);
    `);

    // Prepare statements for better performance
    this.stmts = {
      get: this.db.prepare(`
        SELECT ciphertext, iv, auth_tag, salt, created_at, updated_at, version
        FROM vault_entries
        WHERE vault_name = ? AND entry_key = ?
      `),
      put: this.db.prepare(`
        INSERT OR REPLACE INTO vault_entries
        (vault_name, entry_key, ciphertext, iv, auth_tag, salt, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      delete: this.db.prepare(`
        DELETE FROM vault_entries
        WHERE vault_name = ? AND entry_key = ?
      `),
      keys: this.db.prepare(`
        SELECT entry_key FROM vault_entries WHERE vault_name = ?
      `),
      has: this.db.prepare(`
        SELECT 1 FROM vault_entries WHERE vault_name = ? AND entry_key = ? LIMIT 1
      `),
      all: this.db.prepare(`
        SELECT entry_key, ciphertext, iv, auth_tag, salt, created_at, updated_at, version
        FROM vault_entries
        WHERE vault_name = ?
      `),
      clear: this.db.prepare(`
        DELETE FROM vault_entries WHERE vault_name = ?
      `),
    };
  }

  /**
   * Get an entry from storage
   */
  get(key: string): StoredEntry | undefined {
    const row = this.stmts.get.get(this.vaultName, key) as
      | {
          ciphertext: string;
          iv: string;
          auth_tag: string;
          salt: string | null;
          created_at: string;
          updated_at: string;
          version: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      encrypted: {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        salt: row.salt ?? undefined,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  /**
   * Store an entry
   */
  put(key: string, entry: StoredEntry): void {
    this.stmts.put.run(
      this.vaultName,
      key,
      entry.encrypted.ciphertext,
      entry.encrypted.iv,
      entry.encrypted.authTag,
      entry.encrypted.salt ?? null,
      entry.createdAt,
      entry.updatedAt,
      entry.version
    );
  }

  /**
   * Delete an entry
   */
  delete(key: string): boolean {
    const result = this.stmts.delete.run(this.vaultName, key);
    return result.changes > 0;
  }

  /**
   * Get all keys in this vault
   */
  keys(): string[] {
    const rows = this.stmts.keys.all(this.vaultName) as { entry_key: string }[];
    return rows.map((row) => row.entry_key);
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    return this.stmts.has.get(this.vaultName, key) !== undefined;
  }

  /**
   * Get all entries for export
   */
  getAll(): Record<string, StoredEntry> {
    const rows = this.stmts.all.all(this.vaultName) as {
      entry_key: string;
      ciphertext: string;
      iv: string;
      auth_tag: string;
      salt: string | null;
      created_at: string;
      updated_at: string;
      version: number;
    }[];

    const result: Record<string, StoredEntry> = {};
    for (const row of rows) {
      result[row.entry_key] = {
        encrypted: {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.auth_tag,
          salt: row.salt ?? undefined,
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      };
    }
    return result;
  }

  /**
   * Import entries (for sync/restore)
   */
  importAll(entries: Record<string, StoredEntry>): void {
    const transaction = this.db.transaction(() => {
      for (const [key, entry] of Object.entries(entries)) {
        this.put(key, entry);
      }
    });
    transaction();
  }

  /**
   * Clear all entries in this vault
   */
  clear(): void {
    this.stmts.clear.run(this.vaultName);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
