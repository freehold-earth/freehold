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
 * The returned directory is the root that the Compact compiler produces — it holds
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
        "Install the compiler: compact update 0.36.0\n" +
        "Then compile: cd contract && pnpm run compact"
    );
  }

  return defaultPath;
}

/**
 * Load the compiled contract module from the managed directory, where the
 * compiler writes it as ESM at `<managed>/contract/index.js`.
 *
 * Older compilers wrote elsewhere, and their output is not looked for: it
 * cannot run on the runtime this SDK uses, and loading it would turn "compile
 * the contract again" into an obscure failure deep in a deployment.
 */
export async function loadContractModule(assetsPath: string): Promise<ContractModule> {
  const modulePath = resolve(assetsPath, "contract", "index.js");
  if (existsSync(modulePath)) {
    return loaded(modulePath);
  }
  throw new Error(
    `No compiled contract module found at ${modulePath}. ` +
      "Ensure the Compact contract has been compiled with: cd contract && pnpm run compact"
  );
}

/**
 * A computed import resolves to `any`; the module is checked for the two
 * exports this SDK uses, the Contract class that generation deploys and
 * the ledger() decoder that reads use, so a wrong or broken directory
 * fails here rather than inside a deployment or a chain read. The rest of
 * the shape is taken on trust.
 */
async function loaded(modulePath: string): Promise<ContractModule> {
  const module: unknown = await import(pathToFileURL(modulePath).href);
  const exports = module && typeof module === "object" ? (module as { ledger?: unknown; Contract?: unknown }) : {};
  if (typeof exports.ledger !== "function" || typeof exports.Contract !== "function") {
    throw new Error(`${modulePath} is not a compiled Compact contract: it must export Contract and ledger()`);
  }
  return module as ContractModule;
}
