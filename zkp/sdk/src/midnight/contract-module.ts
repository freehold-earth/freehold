/**
 * The compiled Compact contract, loaded from the managed directory the
 * compiler writes. It is the one place that knows the circuit's ledger
 * layout: `ledger()` turns a contract state read from the chain into the
 * circuit's named fields.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The circuit's ledger as the compiled contract decodes it. */
export interface AgeLedger {
  readonly verified: boolean;
  readonly lastMinAge: bigint;
  readonly requesterCommitment: Uint8Array;
  readonly verificationCount: bigint;
}

export interface ContractModule {
  Contract: unknown;
  witnesses: unknown;
  ledger: (state: unknown) => AgeLedger;
}

/**
 * Resolve the path to compiled contract assets (managed/ directory).
 *
 * Priority: explicit path > default relative path from contract/managed.
 *
 * The returned directory is the root that Compact 0.31.0 produces — it holds
 * `contract/`, `keys/`, `zkir/`, and `compiler/` subdirectories.
 * NodeZkConfigProvider reads `keys/` and `zkir/` from this base directory.
 *
 * @throws Error if the resolved path does not exist
 */
export function resolveContractAssetsPath(contractAssetsPath?: string): string {
  if (contractAssetsPath) {
    if (!existsSync(contractAssetsPath)) {
      throw new Error(
        `Contract assets not found at: ${contractAssetsPath}\n` +
          "Run the Compact compiler to generate contract assets: cd contract && pnpm run compact"
      );
    }
    return contractAssetsPath;
  }

  // Default: look relative to the SDK package (../../../contract/managed)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(thisDir, "..", "..", "..", "contract", "managed");

  if (!existsSync(defaultPath)) {
    throw new Error(
      `Compiled contract assets not found at default path: ${defaultPath}\n` +
        "The Compact contract must be compiled before on-chain proofs can be generated.\n" +
        "Install the compiler: compact update 0.31.0\n" +
        "Then compile: cd contract && pnpm run compact"
    );
  }

  return defaultPath;
}

/**
 * Load the compiled contract module from the managed directory.
 *
 * Compact 0.31.0 emits ESM at `<managed>/contract/index.js`. Older 0.28.0
 * output (`<managed>/index.cjs`) is also accepted for backwards compatibility
 * while transitional builds may still be around.
 */
export async function loadContractModule(assetsPath: string): Promise<ContractModule> {
  // Compact 0.31.0 layout: managed/contract/index.js (ESM).
  const esmPath = resolve(assetsPath, "contract", "index.js");
  if (existsSync(esmPath)) {
    return import(pathToFileURL(esmPath).href);
  }

  // Legacy 0.28.0 layout: managed/index.cjs (assetsPath IS the managed/ dir).
  const legacyCjs = resolve(assetsPath, "index.cjs");
  if (existsSync(legacyCjs)) {
    return import(pathToFileURL(legacyCjs).href);
  }
  const legacyEsm = resolve(assetsPath, "index.js");
  if (existsSync(legacyEsm)) {
    return import(pathToFileURL(legacyEsm).href);
  }

  throw new Error(
    `No compiled contract module found under ${assetsPath}. Looked for:\n` +
      `  ${esmPath}\n  ${legacyCjs}\n  ${legacyEsm}\n` +
      "Ensure the Compact contract has been compiled with: cd contract && pnpm run compact"
  );
}
