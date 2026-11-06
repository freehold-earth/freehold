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

/** The most a request body may carry; an entry is one encrypted blob. */
const MAX_BODY_BYTES = 1_048_576

/** A request body larger than the store reads. */
class RequestTooLarge extends Error {
  constructor() {
    super(`Request body is over ${MAX_BODY_BYTES} bytes`)
  }
}

/** A request the client got wrong; answered with 400 and the reason. */
class BadRequest extends Error {}

/**
 * The request's JSON body, or `{}` when empty; bounded, and decoded whole.
 *
 * Past the bound the stream is paused, not destroyed, so the 413 can leave
 * before the socket closes.
 */
async function parseBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let settled = false
    req.on("data", (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        settled = true
        req.pause()
        reject(new RequestTooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      const body = Buffer.concat(chunks).toString("utf8")
      let parsed: unknown
      try {
        parsed = body ? JSON.parse(body) : {}
      } catch {
        reject(new BadRequest("Invalid JSON"))
        return
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        reject(new BadRequest("Body must be a JSON object"))
        return
      }
      resolve(parsed as Record<string, unknown>)
    })
    req.on("error", reject)
  })
}

/** Bytes from a base64 field, refusing anything but canonical base64. */
function base64Field(value: unknown, name: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new BadRequest(`'${name}' must be base64`)
  }
  return new Uint8Array(Buffer.from(value, "base64"))
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
 * The origins pass through {@link parseOrigins}, so they are held in the
 * form a browser sends and a wildcard is refused: one rule, wherever the
 * list comes from.
 *
 * @throws Error when an origin is a wildcard, not `https://`, or more than an origin.
 */
export function createApp(options: AppOptions): App {
  const origins = parseOrigins(options.origins.join(","))
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

  /** A key from the path, or null when it is not valid percent-encoding. */
  function keyOf(match: RegExpMatchArray): string | null {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return null
    }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || "/", "https://localhost")
    const pathname = url.pathname
    const method = req.method || "GET"
    // No Origin means no browser page: the agent, curl, another service. The
    // allowlist is a boundary for pages, which CORS exists for; it is not
    // authentication, which the store does not have yet.
    const origin = req.headers.origin
    const allowed = origin === undefined || origins.includes(origin)
    // Every answer varies on Origin, so a cache never hands one page another's.
    const cors: Record<string, string> = { Vary: "Origin" }
    if (origin !== undefined && allowed) {
      cors["Access-Control-Allow-Origin"] = origin
      cors["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
      cors["Access-Control-Allow-Headers"] = "Content-Type, X-User-ID"
    }

    function sendJson(
      data: unknown,
      status = 200,
      extra: Record<string, string> = {},
    ): void {
      res.writeHead(status, {
        "Content-Type": "application/json",
        ...cors,
        ...extra,
      })
      res.end(JSON.stringify(data))
    }
    function sendError(
      message: string,
      status = 400,
      extra: Record<string, string> = {},
    ): void {
      sendJson({ error: message }, status, extra)
    }

    // A page outside the allowlist gets nothing, reads included: CORS would
    // only hide the answer from a request that still ran, and even a read
    // opens the named user's database.
    if (!allowed) {
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

    // The user id identifies the local user or device. Node joins a repeated
    // header with ", ", which the token shape refuses: a repeated id is no id.
    const header = req.headers["x-user-id"]
    const userId = typeof header === "string" ? header : "default"
    if (!USER_ID.test(userId)) {
      sendError(
        "X-User-ID must be 1 to 128 letters, digits, '.', '_' or '-'",
        400,
      )
      return
    }
    // Opened by the route that needs it, so an unknown path opens nothing.
    const store = () => getStorage(userId)

    try {
      // GET /entries - List all keys
      if (pathname === "/entries" && method === "GET") {
        sendJson({ keys: store().keys() })
        return
      }

      // Match /entries/:key routes
      const entryMatch = pathname.match(/^\/entries\/(.+)$/)

      // GET /entries/:key - Get a specific entry
      if (entryMatch && method === "GET") {
        const key = keyOf(entryMatch)
        if (key === null) {
          sendError("Malformed key")
          return
        }
        const entry = store().get(key)
        if (entry) {
          sendJson(entry)
        } else {
          sendError("Not found", 404)
        }
        return
      }

      // PUT /entries/:key - Store an entry (client sends pre-encrypted data)
      if (entryMatch && method === "PUT") {
        const key = keyOf(entryMatch)
        if (key === null) {
          sendError("Malformed key")
          return
        }
        const body = await parseBody(req)
        if (typeof body.encrypted_data !== "string" || !body.encrypted_data) {
          sendError("Missing 'encrypted_data' field")
          return
        }
        const result = store().put(key, body.encrypted_data)
        sendJson(result, 201)
        return
      }

      // DELETE /entries/:key - Delete an entry
      if (entryMatch && method === "DELETE") {
        const key = keyOf(entryMatch)
        if (key === null) {
          sendError("Malformed key")
          return
        }
        const deleted = store().delete(key)
        sendJson({ deleted })
        return
      }

      // POST /sync - Get CRDT update for sync
      if (pathname === "/sync" && method === "POST") {
        const body = await parseBody(req)
        let update: Uint8Array

        if (body.state_vector) {
          // Get updates since the provided state vector, once it decodes.
          const stateVector = base64Field(body.state_vector, "state_vector")
          try {
            Y.decodeStateVector(stateVector)
          } catch {
            throw new BadRequest("Invalid state vector")
          }
          update = store().getUpdatesSince(stateVector)
        } else {
          // Get full state
          update = store().getUpdatesSince(new Uint8Array(0))
        }

        sendJson({
          update: Buffer.from(update).toString("base64"),
        })
        return
      }

      // POST /sync/apply - Apply a sync update from another device
      if (pathname === "/sync/apply" && method === "POST") {
        const body = await parseBody(req)
        if (!body.update) {
          sendError("Missing 'update' field")
          return
        }
        const updateBytes = base64Field(body.update, "update")
        // Proven on a scratch document first, so a failure to persist a
        // valid update stays the server's error, not the client's.
        try {
          Y.applyUpdate(new Y.Doc(), updateBytes)
        } catch {
          throw new BadRequest("Invalid update")
        }
        store().applyUpdate(updateBytes)
        sendJson({ applied: true })
        return
      }

      // GET /sync/state - Get state vector for sync negotiation
      if (pathname === "/sync/state" && method === "GET") {
        const stateVector = store().getStateVector()
        sendJson({
          state_vector: Buffer.from(stateVector).toString("base64"),
        })
        return
      }

      // Not found
      sendError("Not found", 404)
    } catch (error) {
      if (error instanceof BadRequest) {
        sendError(error.message, 400)
        return
      }
      if (error instanceof RequestTooLarge) {
        // The unread body makes keep-alive unsafe: say so, then close.
        sendError(error.message, 413, { Connection: "close" })
        res.once("finish", () => req.destroy())
        return
      }
      // The detail goes to the log; the client learns only that it failed.
      console.error("Request error:", error)
      if (res.headersSent) {
        res.destroy()
      } else {
        sendError("Internal error", 500)
      }
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
