/**
 * Freehold ZKP Service HTTP Server
 *
 * HTTP server that exposes proof generation endpoints.
 * Proof handlers are registered via the barrel file in ./proofs/index.ts
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { ProofConfig } from "./types.js";
import { isNetworkAvailable, type MidnightConfig, type MidnightNetwork } from "./midnight/client.js";
import { DustCapacityError, getExistingWallet, getOrCreateWallet } from "./midnight/wallet.js";
import { AgeVerification } from "./proofs/age-verification.js";
import * as proofModules from "./proofs/index.js";

// The package's own version, read at runtime so the root route cannot fall
// behind the release. Resolves to zkp/sdk/package.json from src/ and dist/ alike.
const { version: SERVICE_VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const PORT = parseInt(process.env.PORT || "8084", 10);

const VALID_NETWORKS = [
  "standalone",
  "testnet",
  "preview",
  "preprod",
  "mainnet",
] as const satisfies readonly MidnightNetwork[];

function parseMidnightNetwork(raw: string | undefined): MidnightNetwork | undefined {
  if (!raw) return undefined;
  if ((VALID_NETWORKS as readonly string[]).includes(raw)) return raw as MidnightNetwork;
  throw new Error(
    `Invalid MIDNIGHT_NETWORK '${raw}'. Must be one of: ${VALID_NETWORKS.join(", ")}`
  );
}

interface ProofHandler {
  generate(input: unknown): Promise<unknown>;
}

// Proof handlers registry
const proofHandlers: Record<string, ProofHandler> = {};

/**
 * Load all proof handlers from the barrel export.
 *
 * Reads Midnight network configuration from environment variables and
 * passes it through to each proof handler constructor so that handlers
 * can connect to the correct node, indexer, and proof server.
 */
function loadProofHandlers(): ProofConfig & MidnightConfig {
  const network = parseMidnightNetwork(process.env.MIDNIGHT_NETWORK);

  const config: ProofConfig & MidnightConfig = {
    ...(process.env.PROOF_SERVER_URL && { proverEndpoint: process.env.PROOF_SERVER_URL }),
    ...(( process.env.MIDNIGHT_PROOF_SERVER_URL || process.env.PROOF_SERVER_URL) && {
      proofServerUrl: process.env.MIDNIGHT_PROOF_SERVER_URL ?? process.env.PROOF_SERVER_URL,
    }),
    ...(process.env.MIDNIGHT_NODE_URL && { nodeUrl: process.env.MIDNIGHT_NODE_URL }),
    ...(process.env.MIDNIGHT_INDEXER_URL && { indexerUrl: process.env.MIDNIGHT_INDEXER_URL }),
    ...(network && { network }),
    ...(process.env.MIDNIGHT_WALLET_SEED && { walletSeed: process.env.MIDNIGHT_WALLET_SEED }),
  };

  for (const [name, HandlerClass] of Object.entries(proofModules)) {
    if (typeof HandlerClass !== "function") continue;

    const handler = new HandlerClass(config) as ProofHandler;

    // Register with lowercase name (e.g., "ageverification")
    const lowerName = name.toLowerCase();
    proofHandlers[lowerName] = handler;

    // Also register short name (e.g., "age" from "AgeVerification")
    const shortName = name.replace(/Verification|Proof$/i, "").toLowerCase();
    if (shortName !== lowerName) {
      proofHandlers[shortName] = handler;
    }

    console.log(`[ZKP] Loaded proof handler: ${shortName}`);
  }
  return config;
}

/**
 * Create the service wallet as soon as a Midnight network is reachable, so
 * the health report can name the DUST address to sponsor before any proof
 * has been asked for. Without a network the wallet stays uncreated and the
 * handlers keep their offline behaviour.
 */
async function warmServiceWallet(config: MidnightConfig): Promise<void> {
  if (!(await isNetworkAvailable(config))) return;
  const wallet = await getOrCreateWallet(new AgeVerification(config).walletConfig());
  console.log(`[ZKP] Service wallet ready; DUST address ${wallet.dustAddress}`);
}

/**
 * The service wallet's DUST address and balance, so an operator knows where
 * to sponsor proof fees and whether capacity exists. Null until a proof has
 * created the wallet; a balance that cannot be read is reported as null.
 */
async function dustStatus(): Promise<{ address: string; balance: string | null } | null> {
  const wallet = getExistingWallet();
  if (wallet === null) return null;
  try {
    return { address: wallet.dustAddress, balance: (await wallet.dustBalance()).toString() };
  } catch (err) {
    console.error("[ZKP] Could not read the DUST balance:", err);
    return { address: wallet.dustAddress, balance: null };
  }
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const { method, url } = req;

  // CORS preflight
  if (method === "OPTIONS") {
    sendJson(res, {});
    return;
  }

  if (method === "GET" && url === "/health") {
    sendJson(res, { status: "healthy", service: "freehold-zkp", dust: await dustStatus() });
    return;
  }

  if (method === "GET" && url === "/") {
    sendJson(res, {
      service: "freehold-zkp",
      version: SERVICE_VERSION,
      supportedProofTypes: [...new Set(Object.keys(proofHandlers))],
      endpoints: ["/health", "/proofs/:type"],
    });
    return;
  }

  // Handle POST /proofs/:type
  if (method === "POST" && url?.startsWith("/proofs/")) {
    const proofType = url.split("/")[2];
    const handler = proofHandlers[proofType];

    if (!handler) {
      sendJson(res, {
        error: `Unknown proof type: ${proofType}`,
        available: [...new Set(Object.keys(proofHandlers))]
      }, 400);
      return;
    }

    try {
      const body = await readBody(req);
      const input = JSON.parse(body);

      // Generate proof using the handler
      // Handler is responsible for parsing its own input format
      const proof = await handler.generate(input);

      console.log(`[ZKP] Generated ${proofType} proof`);
      sendJson(res, { status: "success", proof });
    } catch (err) {
      if (err instanceof DustCapacityError) {
        console.error(`[ZKP] ${err.message}`);
        sendJson(res, { error: err.message, dustAddress: err.dustAddress }, 402);
        return;
      }
      console.error(`[ZKP] Error generating ${proofType} proof:`, err);
      sendJson(res, { error: "Proof generation failed" }, 500);
    }
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

// Load handlers and start server
const serviceConfig = loadProofHandlers();
warmServiceWallet(serviceConfig).catch((err) => {
  console.error("[ZKP] Could not create the service wallet at startup:", err);
});

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    sendJson(res, { error: "Internal server error" }, 500);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Freehold ZKP Service starting on port ${PORT}`);
  console.log(`Loaded proof types: ${[...new Set(Object.keys(proofHandlers))].join(", ")}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
