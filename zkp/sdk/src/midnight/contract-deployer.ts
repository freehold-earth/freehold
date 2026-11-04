/**
 * Ephemeral Contract Deployment for Age Verification
 *
 * Each proof interaction deploys a FRESH contract instance to prevent
 * cross-verifier correlation (Company A and B cannot link proofs to the same user).
 *
 * Flow:
 * 1. Bridge the wallet to a midnight-js wallet/midnight provider
 * 2. Load compiled contract assets and build the ZK config provider
 * 3. Build the compiled contract with age witnesses (private birth date → ZK circuit)
 * 4. Assemble MidnightProviders (public data, proof, wallet, zk config, private state)
 * 5. Deploy fresh contract with initial private state
 * 6. Call verifyAge circuit — generates ZK proof, submits tx — and read the result
 *
 * The private state lives in memory for the duration of one call; see
 * private-state.ts.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { withEphemeralPrivateState } from "./private-state.js";
import { createAgeWitnesses, parseDateForCircuit } from "./witnesses.js";
import {
  createWalletAndMidnightProvider,
  DustCapacityError,
  type ManagedWallet,
  type WalletConfig,
} from "./wallet.js";

export interface DeploymentResult {
  txId: string;
  contractAddress: string;
  blockHeight: number;
  verified: boolean;
  /**
   * DUST the proof's transactions (deployment, circuit call, state read)
   * cost, in specks, summed from the fee estimates taken before each was
   * balanced
   */
  dustFee: bigint;
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
 * Deploy a fresh ephemeral contract and call verifyAge.
 *
 * Each call deploys a new contract instance for privacy — no cross-verifier linkability.
 */
export async function deployAndVerifyAge(
  wallet: ManagedWallet,
  config: WalletConfig,
  birthDate: Date,
  minAge: number,
  currentDate: Date,
  contractAssetsPath: string,
): Promise<DeploymentResult> {
  if (!Number.isInteger(minAge) || minAge < 0) {
    throw new RangeError("minAge must be a non-negative integer");
  }

  // A wallet with no DUST at all cannot pay for anything below; say so
  // before loading assets or building a transaction. The exact fee is
  // checked against the balance when each transaction is balanced.
  const available = await wallet.dustBalance();
  if (available === 0n) {
    throw new DustCapacityError(wallet.dustAddress, available);
  }

  // 1. Create wallet/midnight provider (bridges facade to midnight-js-contracts)
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(wallet);

  // 2. Load compiled contract and build ZK config provider
  const zkConfigProvider = new NodeZkConfigProvider<string>(contractAssetsPath);

  // 3. Build the compiled contract with witnesses
  // The Contract type is loaded dynamically from compiled assets (may not exist at build time).
  // Type assertions are unavoidable since the contract module doesn't exist at compile time.
  const { Contract } = await loadContractModule(contractAssetsPath);

  // Create witness functions that provide the private birth date to the ZK circuit.
  // The birth date never leaves the device — only the proof that age >= threshold.
  const ageWitnesses = createAgeWitnesses(birthDate);

  // The compiled contract types are fully dynamic (loaded at runtime from compactc output).
  // Type assertions are unavoidable — the contract module doesn't exist at compile time.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const makeContract = CompiledContract.make as (...args: any[]) => any;
  const withWitnesses = CompiledContract.withWitnesses as (...args: any[]) => any;
  const withAssets = CompiledContract.withCompiledFileAssets as (...args: any[]) => any;
  const compiledContract = makeContract("proofs", Contract).pipe(
    withWitnesses(ageWitnesses),
    withAssets(contractAssetsPath),
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // 4. Assemble all providers and run the deployment against a private state
  // store that lives only for this call.
  const privateStateId = "ageVerificationPrivateState";
  return withEphemeralPrivateState(async (privateStateProvider) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providers: MidnightProviders<any, any, any> = {
      privateStateProvider,
      publicDataProvider: indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(config.proofServerUrl, zkConfigProvider),
      walletProvider: walletAndMidnightProvider,
      midnightProvider: walletAndMidnightProvider,
    };

    // 5. Deploy the contract
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deployed = await (deployContract as any)(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState: {},
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;

    // 6. Call verifyAge circuit
    const { year, month, day } = parseDateForCircuit(currentDate);

    // The callTx interface is dynamically typed from the compiled contract.
    // The circuit can return verified=false for underage users without throwing,
    // so we must read the actual on-chain state after the tx.
    const contract = deployed as unknown as {
      callTx: {
        verifyAge(
          minAge: bigint,
          currentYear: bigint,
          currentMonth: bigint,
          currentDay: bigint,
        ): Promise<{ txHash: string; blockHeight: number }>;
        getVerified(): Promise<{ txHash: string; blockHeight: number; result: boolean }>;
      };
    };

    const result = await contract.callTx.verifyAge(
      BigInt(minAge),
      year,
      month,
      day,
    );

    // Read the actual verified state from the contract (the circuit sets it via disclose())
    const verifiedResult = await contract.callTx.getVerified();

    return {
      txId: result.txHash,
      contractAddress: String(contractAddress),
      blockHeight: result.blockHeight,
      verified: verifiedResult.result,
      dustFee: walletAndMidnightProvider.dustFees.reduce((sum, fee) => sum + fee, 0n),
    };
  });
}

/**
 * Attempt to load the compiled contract module from the managed directory.
 *
 * Compact 0.31.0 emits ESM at `<managed>/contract/index.js`. Older 0.28.0
 * output (`<managed>/index.cjs`) is also accepted for backwards compatibility
 * while transitional builds may still be around.
 */
async function loadContractModule(assetsPath: string): Promise<{
  Contract: unknown;
  witnesses: unknown;
}> {
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
