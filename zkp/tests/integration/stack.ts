/**
 * The local Midnight stack the integration suite runs against: where its
 * services answer, the wallet that pays, and where the compiled contract is.
 * One place, so a change to the stack is a change to one file.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isNetworkAvailable } from "../../sdk/src/midnight/client.js";

export const PROOF_SERVER_URL = process.env.MIDNIGHT_PROOF_SERVER_URL || "http://localhost:6300";
export const INDEXER_URL = process.env.MIDNIGHT_INDEXER_URL || "http://localhost:8088";
export const NODE_URL = process.env.MIDNIGHT_NODE_URL || "ws://localhost:9944";

/** The dev preset's public genesis wallet, which already holds DUST. */
export const GENESIS_SEED = "0".repeat(63) + "1";

/** Where `pnpm run compact` in contract/ writes the compiled circuit, and where the SDK looks. */
export const CONTRACT_ASSETS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "contract", "managed");

/** The proof service as it runs against the stack, paying from the genesis wallet. */
export const live = {
  proofServerUrl: PROOF_SERVER_URL,
  indexerUrl: INDEXER_URL,
  nodeUrl: NODE_URL,
  walletSeed: GENESIS_SEED,
  contractAssetsPath: CONTRACT_ASSETS_PATH,
};

/** A fresh node syncs the genesis wallet from genesis; this is how long to give it. */
export const WALLET_SYNC_MS = 240_000;

/**
 * Whether the stack is up. A stack that is up without a compiled contract is
 * an error rather than a reason to skip: the on-chain cases are the point of
 * the suite, and they once skipped unnoticed for months.
 */
export async function stackIsUp(): Promise<boolean> {
  const up = await isNetworkAvailable({ proofServerUrl: PROOF_SERVER_URL, indexerUrl: INDEXER_URL, networkCheckTimeoutMs: 5000 });
  if (up && !existsSync(CONTRACT_ASSETS_PATH)) {
    throw new Error(
      `The Midnight stack is up but the compiled contract is missing at ${CONTRACT_ASSETS_PATH}; run "pnpm run compact" in contract/`,
    );
  }
  if (!up && process.env.FREEHOLD_LIVE_REQUIRED) {
    // Where the stack is part of the run, as in CI, its absence is a failure and not a skip.
    throw new Error("FREEHOLD_LIVE_REQUIRED is set but the Midnight stack does not answer");
  }
  if (!up) console.log("Skipping: the Midnight stack is not running (docker compose up -d node proof-server indexer)");
  return up;
}
