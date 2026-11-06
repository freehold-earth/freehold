/**
 * The context store's entry point: configuration from the environment, TLS,
 * and a listening socket around the request handling in ./app.ts.
 */

import * as fs from "node:fs"
import { createServer } from "node:https"
import { createApp, DEFAULT_ORIGINS, parseOrigins } from "./app.js"

const PORT = parseInt(process.env.PORT || "8081", 10)
// Loopback unless deployment says otherwise; a container binds every
// interface so its published port reaches it. Not HOST, which shells set.
const BIND_ADDRESS = process.env.BIND_ADDRESS || "127.0.0.1"
const DATA_DIR = process.env.DATA_DIR || "./data"

// The store is served over TLS or not at all: the vault password crosses this
// link on every unlock. The agent trusts the CA that signed the certificate.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE
const TLS_KEY_FILE = process.env.TLS_KEY_FILE
if (!TLS_CERT_FILE || !TLS_KEY_FILE) {
  console.error(
    "TLS_CERT_FILE and TLS_KEY_FILE must name the store's certificate and key: it is served over TLS only",
  )
  process.exit(1)
}

// The browser origins the store answers; the demo apps' by default, never a wildcard.
let origins: readonly string[] = DEFAULT_ORIGINS
if (process.env.CORS_ORIGINS) {
  try {
    origins = parseOrigins(process.env.CORS_ORIGINS)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const app = createApp({ dataDir: DATA_DIR, origins })

const server = createServer(
  { cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) },
  (req, res) => {
    // handle answers every request itself; a rejection here is a bug to log.
    app.handle(req, res).catch((err) => console.error("Unhandled error:", err))
  },
)

server.listen(PORT, BIND_ADDRESS, () => {
  console.log(
    `Freehold Context Store server listening on https://${BIND_ADDRESS}:${PORT}`,
  )
  console.log(`Data directory: ${DATA_DIR}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...")
  // In-flight requests finish against open databases; then they close.
  server.close(() => {
    app.close()
    console.log("Server closed")
    process.exit(0)
  })
})
