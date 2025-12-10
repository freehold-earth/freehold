/**
 * HTTP Server for PCI Context Store
 *
 * A simple encrypted blob store with CRDT sync support.
 *
 * IMPORTANT: This server has ZERO knowledge of encryption keys.
 * All encryption/decryption happens client-side. The server only
 * stores and retrieves pre-encrypted data blobs.
 *
 * In production, this runs locally on the user's device.
 * The SQLite database is stored locally.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import * as Y from "yjs";
import * as fs from "node:fs";
import * as path from "node:path";

const PORT = parseInt(process.env.PORT || "8081", 10);
const DATA_DIR = process.env.DATA_DIR || "./data";

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Entry stored in the database (already encrypted by client)
 */
interface StoredEntry {
  key: string;
  /** The encrypted data blob (client encrypts before sending) */
  encrypted_data: string;
  created_at: string;
  updated_at: string;
  version: number;
}

/**
 * Per-user storage instance
 */
class UserStorage {
  private db: Database.Database;
  private doc: Y.Doc;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        key TEXT PRIMARY KEY,
        encrypted_data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crdt_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL
      );
    `);

    // Initialize Yjs doc for CRDT sync
    this.doc = new Y.Doc();
    this.loadCRDTState();
  }

  private loadCRDTState(): void {
    const row = this.db.prepare("SELECT state FROM crdt_state WHERE id = 1").get() as { state: Buffer } | undefined;
    if (row) {
      Y.applyUpdate(this.doc, new Uint8Array(row.state));
    }
  }

  private saveCRDTState(): void {
    const state = Y.encodeStateAsUpdate(this.doc);
    this.db.prepare(
      "INSERT OR REPLACE INTO crdt_state (id, state) VALUES (1, ?)"
    ).run(Buffer.from(state));
  }

  keys(): string[] {
    const rows = this.db.prepare("SELECT key FROM entries").all() as { key: string }[];
    return rows.map((r) => r.key);
  }

  get(key: string): StoredEntry | null {
    const row = this.db.prepare("SELECT * FROM entries WHERE key = ?").get(key) as StoredEntry | undefined;
    return row || null;
  }

  put(key: string, encryptedData: string): StoredEntry {
    const now = new Date().toISOString();
    const existing = this.get(key);
    const version = (existing?.version ?? 0) + 1;

    this.db.prepare(`
      INSERT OR REPLACE INTO entries (key, encrypted_data, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, encryptedData, existing?.created_at ?? now, now, version);

    // Update CRDT
    const entries = this.doc.getMap("entries");
    this.doc.transact(() => {
      entries.set(key, { encrypted_data: encryptedData, updated_at: now, version });
    });
    this.saveCRDTState();

    return { key, encrypted_data: encryptedData, created_at: existing?.created_at ?? now, updated_at: now, version };
  }

  delete(key: string): boolean {
    const result = this.db.prepare("DELETE FROM entries WHERE key = ?").run(key);
    if (result.changes > 0) {
      const entries = this.doc.getMap("entries");
      this.doc.transact(() => {
        entries.delete(key);
      });
      this.saveCRDTState();
      return true;
    }
    return false;
  }

  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  getUpdatesSince(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
    this.saveCRDTState();

    // Sync CRDT entries to SQLite
    const entries = this.doc.getMap("entries");
    entries.forEach((value, key) => {
      const entry = value as { encrypted_data: string; updated_at: string; version: number };
      const existing = this.get(key);
      if (!existing || existing.version < entry.version) {
        const now = new Date().toISOString();
        this.db.prepare(`
          INSERT OR REPLACE INTO entries (key, encrypted_data, created_at, updated_at, version)
          VALUES (?, ?, ?, ?, ?)
        `).run(key, entry.encrypted_data, existing?.created_at ?? now, entry.updated_at, entry.version);
      }
    });
  }

  close(): void {
    this.doc.destroy();
    this.db.close();
  }
}

// Storage instances per user
const storageInstances = new Map<string, UserStorage>();

function getStorage(userId: string): UserStorage {
  if (!storageInstances.has(userId)) {
    const dbPath = path.join(DATA_DIR, `${userId}.db`);
    storageInstances.set(userId, new UserStorage(dbPath));
  }
  return storageInstances.get(userId)!;
}

// Parse JSON body
async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// CORS headers
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-ID",
};

// Send JSON response
function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

// Send error response
function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

// Route handlers
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check
  if (pathname === "/health") {
    sendJson(res, { status: "healthy", users: storageInstances.size });
    return;
  }

  // Get user ID from header (identifies the local user/device)
  const userId = req.headers["x-user-id"] as string || "default";
  const storage = getStorage(userId);

  try {
    // GET /entries - List all keys
    if (pathname === "/entries" && method === "GET") {
      sendJson(res, { keys: storage.keys() });
      return;
    }

    // Match /entries/:key routes
    const entryMatch = pathname.match(/^\/entries\/(.+)$/);

    // GET /entries/:key - Get a specific entry
    if (entryMatch && method === "GET") {
      const key = decodeURIComponent(entryMatch[1]);
      const entry = storage.get(key);
      if (entry) {
        sendJson(res, entry);
      } else {
        sendError(res, "Not found", 404);
      }
      return;
    }

    // PUT /entries/:key - Store an entry (client sends pre-encrypted data)
    if (entryMatch && method === "PUT") {
      const key = decodeURIComponent(entryMatch[1]);
      const body = await parseBody(req) as { encrypted_data: string };
      if (!body.encrypted_data) {
        sendError(res, "Missing 'encrypted_data' field");
        return;
      }
      const result = storage.put(key, body.encrypted_data);
      sendJson(res, result, 201);
      return;
    }

    // DELETE /entries/:key - Delete an entry
    if (entryMatch && method === "DELETE") {
      const key = decodeURIComponent(entryMatch[1]);
      const deleted = storage.delete(key);
      sendJson(res, { deleted });
      return;
    }

    // POST /sync - Get CRDT update for sync
    if (pathname === "/sync" && method === "POST") {
      const body = await parseBody(req) as { state_vector?: string };
      let update: Uint8Array;

      if (body.state_vector) {
        // Get updates since the provided state vector
        const stateVector = new Uint8Array(Buffer.from(body.state_vector, "base64"));
        update = storage.getUpdatesSince(stateVector);
      } else {
        // Get full state
        update = storage.getUpdatesSince(new Uint8Array(0));
      }

      sendJson(res, {
        update: Buffer.from(update).toString("base64"),
      });
      return;
    }

    // POST /sync/apply - Apply a sync update from another device
    if (pathname === "/sync/apply" && method === "POST") {
      const body = await parseBody(req) as { update: string };
      if (!body.update) {
        sendError(res, "Missing 'update' field");
        return;
      }
      const updateBytes = new Uint8Array(Buffer.from(body.update, "base64"));
      storage.applyUpdate(updateBytes);
      sendJson(res, { applied: true });
      return;
    }

    // GET /sync/state - Get state vector for sync negotiation
    if (pathname === "/sync/state" && method === "GET") {
      const stateVector = storage.getStateVector();
      sendJson(res, {
        state_vector: Buffer.from(stateVector).toString("base64"),
      });
      return;
    }

    // Not found
    sendError(res, "Not found", 404);
  } catch (error) {
    console.error("Request error:", error);
    sendError(res, error instanceof Error ? error.message : "Internal error", 500);
  }
}

// Start server
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled error:", err);
    sendError(res, "Internal server error", 500);
  });
});

server.listen(PORT, () => {
  console.log(`PCI Context Store server listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  for (const [userId, storage] of storageInstances) {
    console.log(`Closing storage for user: ${userId}`);
    storage.close();
  }
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
