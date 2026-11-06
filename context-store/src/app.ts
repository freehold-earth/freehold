/**
 * The context store's request handling: an encrypted blob store with CRDT
 * sync, one SQLite database per user.
 *
 * IMPORTANT: The store has ZERO knowledge of encryption keys. All
 * encryption and decryption happens client-side; it stores and returns
 * pre-encrypted blobs. In production it runs locally on the user's device.
 *
 * A browser reaches it only from an origin on the allowlist: CORS withholds
 * the response from any other page, and a request that changes state is
 * refused outright, since CORS alone would still let it run.
 */

import * as fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import * as path from "node:path"
import Database from "better-sqlite3"
import * as Y from "yjs"

/**
 * Entry stored in the database (already encrypted by client)
 */
interface StoredEntry {
  key: string
  /** The encrypted data blob (client encrypts before sending) */
  encrypted_data: string
  created_at: string
  updated_at: string
  version: number
}

/**
 * Per-user storage instance
 */
class UserStorage {
  private db: Database.Database
  private doc: Y.Doc

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")

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
    `)

    // Initialize Yjs doc for CRDT sync
    this.doc = new Y.Doc()
    this.loadCRDTState()
  }

  private loadCRDTState(): void {
    const row = this.db
      .prepare("SELECT state FROM crdt_state WHERE id = 1")
      .get() as { state: Buffer } | undefined
    if (row) {
      Y.applyUpdate(this.doc, new Uint8Array(row.state))
    }
  }

  private saveCRDTState(): void {
    const state = Y.encodeStateAsUpdate(this.doc)
    this.db
      .prepare("INSERT OR REPLACE INTO crdt_state (id, state) VALUES (1, ?)")
      .run(Buffer.from(state))
  }

  keys(): string[] {
    const rows = this.db.prepare("SELECT key FROM entries").all() as {
      key: string
    }[]
    return rows.map((r) => r.key)
  }

  get(key: string): StoredEntry | null {
    const row = this.db
      .prepare("SELECT * FROM entries WHERE key = ?")
      .get(key) as StoredEntry | undefined
    return row || null
  }

  put(key: string, encryptedData: string): StoredEntry {
    const now = new Date().toISOString()
    const existing = this.get(key)
    const version = (existing?.version ?? 0) + 1

    this.db
      .prepare(`
      INSERT OR REPLACE INTO entries (key, encrypted_data, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(key, encryptedData, existing?.created_at ?? now, now, version)

    // Update CRDT
    const entries = this.doc.getMap("entries")
    this.doc.transact(() => {
      entries.set(key, {
        encrypted_data: encryptedData,
        updated_at: now,
        version,
      })
    })
    this.saveCRDTState()

    return {
      key,
      encrypted_data: encryptedData,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      version,
    }
  }

  delete(key: string): boolean {
    const result = this.db.prepare("DELETE FROM entries WHERE key = ?").run(key)
    if (result.changes > 0) {
      const entries = this.doc.getMap("entries")
      this.doc.transact(() => {
        entries.delete(key)
      })
      this.saveCRDTState()
      return true
    }
    return false
  }

  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc)
  }

  getUpdatesSince(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector)
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update)
    this.saveCRDTState()

    // Sync CRDT entries to SQLite
    const entries = this.doc.getMap("entries")
    entries.forEach((value, key) => {
      const entry = value as {
        encrypted_data: string
        updated_at: string
        version: number
      }
      const existing = this.get(key)
      if (!existing || existing.version < entry.version) {
        const now = new Date().toISOString()
        this.db
          .prepare(`
          INSERT OR REPLACE INTO entries (key, encrypted_data, created_at, updated_at, version)
          VALUES (?, ?, ?, ?, ?)
        `)
          .run(
            key,
            entry.encrypted_data,
            existing?.created_at ?? now,
            entry.updated_at,
            entry.version,
          )
      }
    })
  }

  close(): void {
    this.doc.destroy()
    this.db.close()
  }
}

// The id names the user's database file, so it is a token: the same shape the
// agent accepts, never a path. A missing header still means the shared default.
const USER_ID = /^[A-Za-z0-9._-]{1,128}$/

/** The browser origins a store answers out of the box: the demo apps' pages. */
export const DEFAULT_ORIGINS: readonly string[] = [
  "https://localhost:4501", // demo user app, compose.
  "https://localhost:4502", // demo business app, compose.
  "https://localhost:3000", // demo user app, vite dev.
  "https://localhost:3001", // demo business app, vite dev.
]

/**
 * Parse an allowlist of browser origins from a comma-separated value.
 *
 * Each is `https://` and a host, as a browser serializes an origin, and is
 * returned in that form (lower-case host, no `:443`, no trailing slash),
 * since the checks against the Origin header are exact. A wildcard is never
 * an origin.
 *
 * @param value - Comma-separated origins, e.g. `https://app.example,https://localhost:3000`.
 * @returns The origins, canonical and deduplicated.
 * @throws Error when a value is a wildcard, not `https://`, or more than an origin.
 */
export function parseOrigins(value: string): string[] {
  const origins: string[] = []
  for (const raw of value.split(",")) {
    const origin = raw.trim()
    if (!origin) continue
    if (origin.includes("*")) {
      throw new Error("CORS_ORIGINS must list origins; '*' is not accepted")
    }
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new Error(
        `CORS_ORIGINS must list https:// origins (scheme and host only), got '${origin}'`,
      )
    }
    if (url.protocol !== "https:" || url.href !== `${url.origin}/`) {
      throw new Error(
        `CORS_ORIGINS must list https:// origins (scheme and host only), got '${origin}'`,
      )
    }
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  return origins
}

// Parse JSON body
async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (_e) {
        reject(new Error("Invalid JSON"))
      }
    })
    req.on("error", reject)
  })
}

export interface AppOptions {
  /** Directory of the per-user SQLite databases; created when missing. */
  dataDir: string
  /** Browser origins answered, and allowed to change state; never a wildcard. */
  origins: readonly string[]
}

export interface App {
  /** Answer one request. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** Close every user's database. */
  close(): void
}

/**
 * Build the store's request handler over `dataDir`, answering `origins`.
 *
 * @throws Error when an origin is a wildcard.
 */
export function createApp(options: AppOptions): App {
  if (options.origins.some((origin) => origin.includes("*"))) {
    throw new Error("origins must list origins; '*' is not accepted")
  }
  const origins = [...options.origins]
  if (!fs.existsSync(options.dataDir)) {
    fs.mkdirSync(options.dataDir, { recursive: true })
  }
  const storageInstances = new Map<string, UserStorage>()

  function getStorage(userId: string): UserStorage {
    let storage = storageInstances.get(userId)
    if (storage === undefined) {
      storage = new UserStorage(path.join(options.dataDir, `${userId}.db`))
      storageInstances.set(userId, storage)
    }
    return storage
  }

  /** CORS headers for an allowed origin, none for anything else. */
  function corsHeaders(origin: string | undefined): Record<string, string> {
    if (origin === undefined || !origins.includes(origin)) return {}
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-User-ID",
      Vary: "Origin",
    }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || "/", "https://localhost")
    const pathname = url.pathname
    const method = req.method || "GET"
    const origin = req.headers.origin
    const foreign = origin !== undefined && !origins.includes(origin)
    const cors = corsHeaders(origin)

    function sendJson(data: unknown, status = 200): void {
      res.writeHead(status, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify(data))
    }
    function sendError(message: string, status = 400): void {
      sendJson({ error: message }, status)
    }

    // A browser's preflight, or a request that changes state, from a page
    // outside the allowlist: CORS would only hide the answer, so it is refused.
    if (foreign && method !== "GET" && method !== "HEAD") {
      sendError("origin not allowed", 403)
      return
    }
    if (method === "OPTIONS") {
      res.writeHead(204, cors)
      res.end()
      return
    }

    if (pathname === "/health") {
      sendJson({ status: "healthy", users: storageInstances.size })
      return
    }

    // Get user ID from header (identifies the local user/device)
    const userId = (req.headers["x-user-id"] as string) || "default"
    if (!USER_ID.test(userId)) {
      sendError(
        "X-User-ID must be 1 to 128 letters, digits, '.', '_' or '-'",
        400,
      )
      return
    }
    const storage = getStorage(userId)

    try {
      // GET /entries - List all keys
      if (pathname === "/entries" && method === "GET") {
        sendJson({ keys: storage.keys() })
        return
      }

      // Match /entries/:key routes
      const entryMatch = pathname.match(/^\/entries\/(.+)$/)

      // GET /entries/:key - Get a specific entry
      if (entryMatch && method === "GET") {
        const key = decodeURIComponent(entryMatch[1])
        const entry = storage.get(key)
        if (entry) {
          sendJson(entry)
        } else {
          sendError("Not found", 404)
        }
        return
      }

      // PUT /entries/:key - Store an entry (client sends pre-encrypted data)
      if (entryMatch && method === "PUT") {
        const key = decodeURIComponent(entryMatch[1])
        const body = (await parseBody(req)) as { encrypted_data: string }
        if (!body.encrypted_data) {
          sendError("Missing 'encrypted_data' field")
          return
        }
        const result = storage.put(key, body.encrypted_data)
        sendJson(result, 201)
        return
      }

      // DELETE /entries/:key - Delete an entry
      if (entryMatch && method === "DELETE") {
        const key = decodeURIComponent(entryMatch[1])
        const deleted = storage.delete(key)
        sendJson({ deleted })
        return
      }

      // POST /sync - Get CRDT update for sync
      if (pathname === "/sync" && method === "POST") {
        const body = (await parseBody(req)) as { state_vector?: string }
        let update: Uint8Array

        if (body.state_vector) {
          // Get updates since the provided state vector
          const stateVector = new Uint8Array(
            Buffer.from(body.state_vector, "base64"),
          )
          update = storage.getUpdatesSince(stateVector)
        } else {
          // Get full state
          update = storage.getUpdatesSince(new Uint8Array(0))
        }

        sendJson({
          update: Buffer.from(update).toString("base64"),
        })
        return
      }

      // POST /sync/apply - Apply a sync update from another device
      if (pathname === "/sync/apply" && method === "POST") {
        const body = (await parseBody(req)) as { update: string }
        if (!body.update) {
          sendError("Missing 'update' field")
          return
        }
        const updateBytes = new Uint8Array(Buffer.from(body.update, "base64"))
        storage.applyUpdate(updateBytes)
        sendJson({ applied: true })
        return
      }

      // GET /sync/state - Get state vector for sync negotiation
      if (pathname === "/sync/state" && method === "GET") {
        const stateVector = storage.getStateVector()
        sendJson({
          state_vector: Buffer.from(stateVector).toString("base64"),
        })
        return
      }

      // Not found
      sendError("Not found", 404)
    } catch (error) {
      console.error("Request error:", error)
      sendError(error instanceof Error ? error.message : "Internal error", 500)
    }
  }

  function close(): void {
    for (const [userId, storage] of storageInstances) {
      console.log(`Closing storage for user: ${userId}`)
      storage.close()
    }
    storageInstances.clear()
  }

  return { handle, close }
}
