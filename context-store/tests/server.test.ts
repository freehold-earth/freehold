/**
 * The store's request handling, driven over TLS the way a client reaches it:
 * certificates from the stack's own script, a server on an ephemeral loopback
 * port, and requests that trust the CA.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import type { IncomingHttpHeaders } from "node:http"
import * as https from "node:https"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type App, createApp, parseOrigins } from "../src/app.js"

const CERTS_SH = fileURLToPath(
  new URL("../../infra/scripts/certs.sh", import.meta.url),
)
const ALLOWED = "https://app.test"
const FOREIGN = "https://evil.test"

function hasTools(): boolean {
  try {
    execFileSync("bash", ["-c", "command -v openssl"], { stdio: "ignore" })
    return existsSync(CERTS_SH)
  } catch {
    console.warn(
      "openssl, bash or infra/scripts/certs.sh missing; skipping the TLS suite",
    )
    return false
  }
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

describe("parseOrigins", () => {
  it("returns each origin in the browser's form", () => {
    expect(
      parseOrigins(
        "https://LocalHost:4501/, https://App.Example:443,https://[::1]:3000",
      ),
    ).toEqual([
      "https://localhost:4501",
      "https://app.example",
      "https://[::1]:3000",
    ])
  })

  it("refuses a wildcard, plain HTTP, and more than an origin", () => {
    for (const bad of [
      "*",
      "https://*.example",
      "http://localhost:4501",
      "https://app.test/page",
      "https://u@app.test",
    ]) {
      expect(() => parseOrigins(bad)).toThrow(/origins/)
    }
  })
})

describe.skipIf(!hasTools())("the store over TLS", () => {
  let app: App
  let server: https.Server
  let ca: Buffer
  let port: number
  let dataDir: string

  function request(
    method: string,
    pathname: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port, method, path: pathname, headers, ca },
        (res) => {
          let data = ""
          res.on("data", (chunk) => {
            data += chunk
          })
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: data,
            }),
          )
        },
      )
      req.on("error", reject)
      req.end(body)
    })
  }

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-tls-"))
    execFileSync("bash", [CERTS_SH, dir, "context-store"], { stdio: "ignore" })
    ca = readFileSync(path.join(dir, "ca.crt"))
    dataDir = path.join(dir, "data")
    // Given in a form a browser never sends; the factory keeps the browser's.
    app = createApp({ dataDir, origins: ["https://App.Test/"] })
    server = https.createServer(
      {
        cert: readFileSync(path.join(dir, "context-store.crt")),
        key: readFileSync(path.join(dir, "context-store.key")),
      },
      (req, res) => void app.handle(req, res),
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string")
      throw new Error("no port")
    port = address.port
  })

  afterAll(async () => {
    app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("answers an allowed origin with CORS headers for it alone", async () => {
    const reply = await request("GET", "/entries", { Origin: ALLOWED })
    expect(reply.status).toBe(200)
    expect(reply.headers["access-control-allow-origin"]).toBe(ALLOWED)
    expect(reply.headers.vary).toBe("Origin")
  })

  it("refuses a foreign origin's read, change and preflight alike", async () => {
    const read = await request("GET", "/entries", {
      Origin: FOREIGN,
      "X-User-ID": "ghost",
    })
    expect(read.status).toBe(403)
    expect(read.headers["access-control-allow-origin"]).toBeUndefined()
    expect(read.headers.vary).toBe("Origin")
    const put = await request(
      "PUT",
      "/entries/secret",
      { Origin: FOREIGN, "Content-Type": "application/json" },
      JSON.stringify({ encrypted_data: "x" }),
    )
    expect(put.status).toBe(403)
    const preflight = await request("OPTIONS", "/entries/secret", {
      Origin: FOREIGN,
    })
    expect(preflight.status).toBe(403)
    const listing = await request("GET", "/entries")
    expect(JSON.parse(listing.body)).toEqual({ keys: [] })
    expect(existsSync(path.join(dataDir, "ghost.db"))).toBe(false)
  })

  it("opens no database for an unknown path, and none for a nameless user", async () => {
    const unknown = await request("GET", "/nope", { "X-User-ID": "stranger" })
    expect(unknown.status).toBe(404)
    expect(existsSync(path.join(dataDir, "stranger.db"))).toBe(false)
    const twice = await request("GET", "/entries", {
      "x-user-id": ["a", "b"] as unknown as string,
    })
    expect(twice.status).toBe(400)
  })

  it("answers a malformed key, a body that is not an entry, and an oversized body", async () => {
    const malformed = await request("GET", "/entries/%E0%A4%A", {})
    expect(malformed.status).toBe(400)
    const notAnEntry = await request(
      "PUT",
      "/entries/k",
      {},
      JSON.stringify({ encrypted_data: 42 }),
    )
    expect(notAnEntry.status).toBe(400)
    const oversized = await request(
      "PUT",
      "/entries/k",
      { "Content-Type": "application/json" },
      JSON.stringify({ encrypted_data: "x".repeat(1_100_000) }),
    )
    expect(oversized.status).toBe(413)
    expect(oversized.headers.connection).toBe("close")
    const badJson = await request("PUT", "/entries/k", {}, "{not json")
    expect(badJson.status).toBe(400)
    const badUpdate = await request(
      "POST",
      "/sync/apply",
      {},
      JSON.stringify({ update: "Zm9vYmFy" }),
    )
    expect(badUpdate.status).toBe(400)
    const notBase64 = await request(
      "POST",
      "/sync/apply",
      {},
      JSON.stringify({ update: "not base64!" }),
    )
    expect(notBase64.status).toBe(400)
    const badVector = await request(
      "POST",
      "/sync",
      {},
      JSON.stringify({ state_vector: "Zm9vYmFy" }),
    )
    expect(badVector.status).toBe(400)
    const notAnObject = await request("PUT", "/entries/k", {}, "null")
    expect(notAnObject.status).toBe(400)
  })

  it("lets an allowed origin and a request with no origin change state", async () => {
    const preflight = await request("OPTIONS", "/entries/a", {
      Origin: ALLOWED,
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers["access-control-allow-origin"]).toBe(ALLOWED)
    const fromPage = await request(
      "PUT",
      "/entries/a",
      { Origin: ALLOWED },
      JSON.stringify({ encrypted_data: "x" }),
    )
    expect(fromPage.status).toBe(201)
    const fromAgent = await request(
      "PUT",
      "/entries/b",
      {},
      JSON.stringify({ encrypted_data: "y" }),
    )
    expect(fromAgent.status).toBe(201)
    const listing = await request("GET", "/entries")
    expect(JSON.parse(listing.body).keys.sort()).toEqual(["a", "b"])
  })

  it("never takes a wildcard, nor an origin that is not https://", () => {
    expect(() => createApp({ dataDir: tmpdir(), origins: ["*"] })).toThrow(
      /'\*'/,
    )
    expect(() =>
      createApp({ dataDir: tmpdir(), origins: ["http://app.test"] }),
    ).toThrow(/https:\/\//)
  })
})
