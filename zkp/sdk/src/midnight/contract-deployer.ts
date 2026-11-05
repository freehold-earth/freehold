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

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { indexerProvider, queryContractState } from "./client.js";
import { loadContractModule } from "./contract-module.js";
import { withEphemeralPrivateState } from "./private-state.js";
import { createAgeWitnesses, parseDateForCircuit } from "./witnesses.js";
import {
  createWalletAndMidnightProvider,
  DustCapacityError,
  type ManagedWallet,
  type WalletConfig,
} from "./wallet.js";

const LEDGER_READ_ATTEMPTS = 3;
const LEDGER_READ_RETRY_MS = 2_000;

/** The ledger after a finalized call, allowing the indexer a moment to show it. */
async function readLedgerAfterCall(
  indexerUrl: string,
  contractAddress: string,
  contractAssetsPath: string,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; ; attempt++) {
    const ledger = await queryContractState(indexerUrl, contractAddress, contractAssetsPath);
    if (ledger !== null || attempt === LEDGER_READ_ATTEMPTS) return ledger;
    await new Promise((resolve) => setTimeout(resolve, LEDGER_READ_RETRY_MS));
  }
}

export interface DeploymentResult {
  txId: string;
  contractAddress: string;
  blockHeight: number;
  verified: boolean;
  /**
   * DUST the proof's transactions (deployment and circuit call) cost, in
   * specks, summed from the fee estimates taken before each was balanced
   */
  dustFee: bigint;
}


/** Width of the circuit's requester commitment, a Bytes<32> ledger field. */
export const REQUESTER_COMMITMENT_LENGTH = 32;

/**
 * Deploy a fresh ephemeral contract and call verifyAge.
 *
 * Each call deploys a new contract instance for privacy — no cross-verifier linkability.
 * The requester commitment is written to the contract's ledger by the circuit,
 * so the proof vouches for who it is for.
 */
export async function deployAndVerifyAge(
  wallet: ManagedWallet,
  config: WalletConfig,
  birthDate: Date,
  minAge: number,
  currentDate: Date,
  contractAssetsPath: string,
  requesterCommitment: Uint8Array,
): Promise<DeploymentResult> {
  if (!Number.isInteger(minAge) || minAge < 0) {
    throw new RangeError("minAge must be a non-negative integer");
  }
  if (requesterCommitment.length !== REQUESTER_COMMITMENT_LENGTH) {
    throw new RangeError(`requesterCommitment must be ${REQUESTER_COMMITMENT_LENGTH} bytes`);
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
      publicDataProvider: indexerProvider(config.indexerUrl, config.indexerWsUrl),
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
    // A finalized call carries its public transaction data under `public`
    // (midnight-js 4.1.1's FinalizedCallTxData); re-check this shape when
    // midnight-js moves, since a changed shape reads as undefined fields.
    const contract = deployed as unknown as {
      callTx: {
        verifyAge(
          minAge: bigint,
          currentYear: bigint,
          currentMonth: bigint,
          currentDay: bigint,
          requester: Uint8Array,
        ): Promise<{ public: { txId: string; blockHeight: number } }>;
      };
    };

    const result = await contract.callTx.verifyAge(
      BigInt(minAge),
      year,
      month,
      day,
      requesterCommitment,
    );

    // The circuit can leave verified=false for an underage holder without
    // throwing, so the flag is read from the ledger the call wrote rather than
    // assumed. The indexer has the call's state once the call is finalized,
    // but its reads can lag or stall, and by now the call is paid for, so the
    // read is retried and a final failure names what was submitted.
    const ledger = await readLedgerAfterCall(config.indexerUrl, String(contractAddress), contractAssetsPath);
    if (ledger === null) {
      throw new Error(
        `The circuit call ${result.public.txId} on contract ${String(contractAddress)} was submitted ` +
          "but its ledger could not be read back from the indexer",
      );
    }

    return {
      txId: result.public.txId,
      contractAddress: String(contractAddress),
      blockHeight: result.public.blockHeight,
      verified: ledger.verified === true,
      dustFee: walletAndMidnightProvider.dustFees.reduce((sum, fee) => sum + fee, 0n),
    };
  });
}

