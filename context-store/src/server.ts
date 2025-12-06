/**
 * PCI Context Store HTTP Server
 *
 * REST API for encrypted vault storage and vector search.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { EncryptedVault } from "./vault/encrypted-vault.js";
import { SQLiteVectorStore } from "./vectors/index.js";
import type { VectorSearchResult } from "./vectors/index.js";

const PORT = parseInt(process.env.PORT || "8081", 10);
const DATA_DIR = process.env.DATA_DIR || "./data";

// Store vaults by name
const vaults = new Map<string, EncryptedVault>();

// Vector store (shared across vaults for now)
let vectorStore: SQLiteVectorStore | null = null;

// Helper to parse JSON body
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Helper to send JSON response
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

// Helper to send error response
function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

// Get or create vault
async function getOrCreateVault(name: string): Promise<EncryptedVault> {
  if (vaults.has(name)) {
    return vaults.get(name)!;
  }

  const vault = new EncryptedVault({
    name,
    storage: {
      type: "sqlite",
      path: `${DATA_DIR}/${name}.db`,
    },
  });
  await vault.initialize();
  vaults.set(name, vault);
  return vault;
}

// Get or create vector store
function getVectorStore(dimensions = 384): SQLiteVectorStore {
  if (!vectorStore) {
    vectorStore = new SQLiteVectorStore({
      path: `${DATA_DIR}/vectors.db`,
      dimensions,
      distanceMetric: "cosine",
    });
  }
  return vectorStore;
}

// Route handler
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  try {
    // Health check
    if (path === "/health" && method === "GET") {
      const vaultCount = vaults.size;
      const vectorCount = vectorStore ? await vectorStore.count() : 0;
      json(res, {
        status: "healthy",
        service: "pci-context-store",
        vaults: vaultCount,
        vectors: vectorCount,
      });
      return;
    }

    // Service info
    if (path === "/" && method === "GET") {
      json(res, {
        service: "pci-context-store",
        version: "0.1.0",
        endpoints: [
          "GET  /health",
          "GET  /vaults",
          "POST /vaults",
          "GET  /vaults/:name/keys",
          "POST /vaults/:name/entries",
          "GET  /vaults/:name/entries/:key",
          "DELETE /vaults/:name/entries/:key",
          "POST /vectors",
          "POST /vectors/search",
          "GET  /vectors/count",
          "DELETE /vectors/:id",
        ],
      });
      return;
    }

    // List all vaults
    if (path === "/vaults" && method === "GET") {
      json(res, { vaults: Array.from(vaults.keys()) });
      return;
    }

    // Create vault
    if (path === "/vaults" && method === "POST") {
      const body = await parseBody<{ name: string }>(req);
      if (!body.name) {
        error(res, "Vault name required");
        return;
      }
      const vault = await getOrCreateVault(body.name);
      const keys = await vault.keys();
      json(res, { name: body.name, keys: keys.length }, 201);
      return;
    }

    // Vault operations: /vaults/:name/...
    const vaultMatch = path.match(/^\/vaults\/([^/]+)(\/.*)?$/);
    if (vaultMatch) {
      const vaultName = decodeURIComponent(vaultMatch[1]);
      const subPath = vaultMatch[2] || "";

      const vault = await getOrCreateVault(vaultName);

      // List keys
      if (subPath === "/keys" && method === "GET") {
        const keys = await vault.keys();
        json(res, { keys });
        return;
      }

      // Create/update entry
      if (subPath === "/entries" && method === "POST") {
        const body = await parseBody<{ key: string; data: unknown }>(req);
        if (!body.key || body.data === undefined) {
          error(res, "Key and data required");
          return;
        }
        await vault.put(body.key, body.data);
        json(res, { success: true, key: body.key }, 201);
        return;
      }

      // Get entry
      const entryMatch = subPath.match(/^\/entries\/(.+)$/);
      if (entryMatch && method === "GET") {
        const key = decodeURIComponent(entryMatch[1]);
        const entry = await vault.get(key);
        if (!entry) {
          error(res, "Entry not found", 404);
          return;
        }
        json(res, { key, data: entry.data, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
        return;
      }

      // Delete entry
      if (entryMatch && method === "DELETE") {
        const key = decodeURIComponent(entryMatch[1]);
        const deleted = await vault.delete(key);
        json(res, { success: deleted });
        return;
      }

      // Export vault
      if (subPath === "/export" && method === "GET") {
        const data = await vault.export();
        json(res, { data });
        return;
      }
    }

    // Vector operations
    if (path === "/vectors" && method === "POST") {
      const body = await parseBody<{
        id: string;
        embedding: number[];
        metadata?: Record<string, unknown>;
        dimensions?: number;
      }>(req);

      if (!body.id || !body.embedding) {
        error(res, "ID and embedding required");
        return;
      }

      const store = getVectorStore(body.dimensions || body.embedding.length);
      await store.add(body.id, body.embedding, body.metadata);
      json(res, { success: true, id: body.id }, 201);
      return;
    }

    if (path === "/vectors/search" && method === "POST") {
      const body = await parseBody<{
        embedding: number[];
        k?: number;
        dimensions?: number;
      }>(req);

      if (!body.embedding) {
        error(res, "Embedding required");
        return;
      }

      const store = getVectorStore(body.dimensions || body.embedding.length);
      const results: VectorSearchResult[] = await store.search(
        body.embedding,
        body.k || 10
      );
      json(res, { results });
      return;
    }

    if (path === "/vectors/count" && method === "GET") {
      const count = vectorStore ? await vectorStore.count() : 0;
      json(res, { count });
      return;
    }

    // Delete vector
    const vectorDeleteMatch = path.match(/^\/vectors\/(.+)$/);
    if (vectorDeleteMatch && method === "DELETE") {
      const id = decodeURIComponent(vectorDeleteMatch[1]);
      if (!vectorStore) {
        error(res, "Vector store not initialized", 404);
        return;
      }
      const deleted = await vectorStore.delete(id);
      json(res, { success: deleted });
      return;
    }

    // 404
    error(res, "Not found", 404);
  } catch (err) {
    console.error("Request error:", err);
    error(res, err instanceof Error ? err.message : "Internal error", 500);
  }
}

// Create data directory
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // Directory may already exist
}

// Start server
const server = createServer(handleRequest);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`PCI Context Store starting on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
