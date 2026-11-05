/**
 * Midnight Network Client (Ledger 8.1.0)
 *
 * Handles connection to Midnight services (node, proof server, indexer)
 * and provides wallet setup + ephemeral contract deployment.
 *
 * Each proof interaction deploys a fresh contract instance to prevent
 * cross-verifier correlation (Company A and B cannot link proofs to the same user).
 */

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { loadContractModule, resolveContractAssetsPath } from "./contract-module.js";
import {
  type DeployedContract,
  deployContract,
  findDeployedContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import type { FinalizedTxData } from "@midnight-ntwrk/midnight-js-types";

/** Supported Midnight network targets. */
export type MidnightNetwork =
  | "standalone"
  | "testnet"
  | "preview"
  | "preprod"
  | "mainnet";

export interface MidnightConfig {
  /** Proof server URL (default: http://localhost:6300) */
  proofServerUrl?: string;
  /** Indexer URL (default: http://localhost:8088) */
  indexerUrl?: string;
  /** Node WebSocket URL (default: ws://localhost:9944) */
  nodeUrl?: string;
  /** Network type */
  network?: MidnightNetwork;
  /** Force offline mode — network will not be checked; proofs use placeholders */
  forceOffline?: boolean;
  /** Network check timeout in ms (default: 1000) */
  networkCheckTimeoutMs?: number;
  /**
   * Path to the compiled contract assets (the managed/ directory). Needed to
   * generate proofs and to verify them: a verifier decodes the contract's
   * ledger with the compiled contract.
   */
  contractAssetsPath?: string;
  /** Hex-encoded wallet seed for HD key derivation */
  walletSeed?: string;
}

export interface MidnightProviders {
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
}

const DEFAULT_CONFIG: Required<MidnightConfig> = {
  proofServerUrl: "http://localhost:6300",
  indexerUrl: "http://localhost:8088",
  nodeUrl: "ws://localhost:9944",
  network: "standalone",
  forceOffline: false,
  networkCheckTimeoutMs: 1000,
  contractAssetsPath: "",
  walletSeed: "",
};

/**
 * Build indexer GraphQL URLs from either a base URL or an existing
 * /api/v3/graphql / /api/v4/graphql endpoint.
 *
 * Ledger 8 uses /api/v4/ paths (v3 remains a backwards-compat alias on
 * indexer-standalone 4.x, but new work targets v4 explicitly). Callers that
 * already normalised the endpoint (e.g. AgeVerification.buildWalletConfig)
 * pass the full path in, so we detect it and avoid double-appending.
 */
export function buildIndexerUrls(indexerUrl: string): { httpUrl: string; wsUrl: string } {
  const parsed = new URL(indexerUrl);
  const normalisedPath = parsed.pathname.replace(/\/$/, "");
  const alreadyHasEndpoint =
    normalisedPath.endsWith("/api/v4/graphql") ||
    normalisedPath.endsWith("/api/v3/graphql");

  const http = new URL(parsed.href);
  if (alreadyHasEndpoint) {
    http.pathname = normalisedPath;
  } else {
    const base = http.href.endsWith("/") ? http.href : `${http.href}/`;
    http.href = new URL("api/v4/graphql", base).href;
  }

  const ws = new URL(http.href);
  ws.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  ws.pathname = ws.pathname.replace(/\/+$/, "");
  if (!ws.pathname.endsWith("/ws")) {
    ws.pathname = `${ws.pathname}/ws`;
  }

  return { httpUrl: http.href, wsUrl: ws.href };
}

const indexerProviders = new Map<string, ReturnType<typeof indexerPublicDataProvider>>();

/**
 * The public data provider for an indexer, one per indexer for the life of
 * the process: each carries an HTTP client and a websocket client, which
 * are worth keeping rather than rebuilding for every read. A process talks
 * to one or two indexers, so the map is never evicted.
 */
export function indexerProvider(httpUrl: string, wsUrl: string): ReturnType<typeof indexerPublicDataProvider> {
  const key = `${httpUrl} ${wsUrl}`;
  let provider = indexerProviders.get(key);
  if (provider === undefined) {
    provider = indexerPublicDataProvider(httpUrl, wsUrl);
    indexerProviders.set(key, provider);
  }
  return provider;
}

/**
 * Create Midnight providers for contract interaction
 */
export function createProviders(config: MidnightConfig = {}): MidnightProviders {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Note: proofProvider requires zkConfigProvider (compiled contract assets),
  // so it's created per-deployment in the proof generation flow, not here.
  const { httpUrl, wsUrl } = buildIndexerUrls(mergedConfig.indexerUrl);
  return { publicDataProvider: indexerProvider(httpUrl, wsUrl) };
}

/**
 * Check if Midnight network is available.
 *
 * Verifies both the proof server (GET /health) and the indexer
 * (lightweight GraphQL introspection query). Both must respond
 * successfully for the network to be considered available.
 */
export async function isNetworkAvailable(config: MidnightConfig = {}): Promise<boolean> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (mergedConfig.forceOffline) {
    return false;
  }

  const timeout = mergedConfig.networkCheckTimeoutMs;

  try {
    const [proofServerResult, indexerResult] = await Promise.all([
      fetch(`${mergedConfig.proofServerUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(timeout),
      }).then((r) => r.ok).catch(() => false),
      fetch(buildIndexerUrls(mergedConfig.indexerUrl).httpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
        signal: AbortSignal.timeout(timeout),
      }).then((r) => r.ok).catch(() => false),
    ]);

    return proofServerResult && indexerResult;
  } catch {
    return false;
  }
}

/** GraphQL response shape with optional errors array. */
interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const INDEXER_READ_TIMEOUT_MS = 10_000;

/**
 * The circuit's ledger for a contract, as the chain holds it now.
 *
 * The indexer serves the contract's latest state serialized; the public data
 * provider deserializes it and the compiled contract names its fields, so the
 * fields come back as the circuit declared them (`requesterCommitment` as the
 * 32 bytes the circuit wrote). Null when the contract is unknown to the
 * indexer or the read fails or stalls; a failure is logged. A compiled
 * contract that cannot be found is a configuration error and is thrown, so a
 * misconfigured verifier is not mistaken for a forged proof.
 */
export async function queryContractState(
  indexerUrl: string,
  contractAddress: string,
  contractAssetsPath?: string,
): Promise<Record<string, unknown> | null> {
  const { httpUrl, wsUrl } = buildIndexerUrls(indexerUrl);
  // Configuration errors escape; only the chain read and its decoding can
  // answer "no state".
  const { ledger } = await loadContractModule(resolveContractAssetsPath(contractAssetsPath));
  try {
    const state = await withDeadline(
      indexerProvider(httpUrl, wsUrl).queryContractState(contractAddress),
      INDEXER_READ_TIMEOUT_MS,
    );
    if (state === null) return null;
    return { ...ledger(state.data) };
  } catch (err) {
    console.warn("queryContractState: could not read the contract's ledger:", err);
    return null;
  }
}

/**
 * The promise's value, or a rejection once the deadline passes without one.
 * The provider's query cannot be aborted, so a late answer is left to settle
 * unobserved; a query that never settles can keep a test runner's process
 * alive until the runner ends it, but no caller waits past the deadline.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the indexer did not answer within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** One thing a transaction did to a contract: deployed it, called a circuit on it, or updated it. */
export interface ContractAction {
  address: string;
  kind: "deploy" | "call" | "update";
  /** The circuit called, for a call. */
  entryPoint?: string;
}

/**
 * The block a transaction was included in and what it did to which
 * contracts, by the transaction identifier a finalized transaction reports;
 * null when the indexer does not know it. GraphQL-level errors are logged
 * for diagnostics.
 */
export async function queryTransaction(
  indexerUrl: string,
  txId: string,
): Promise<{ blockHeight: number; contractActions: ContractAction[] } | null> {
  const { httpUrl } = buildIndexerUrls(indexerUrl);

  const query = `
    query Transaction($offset: TransactionOffset!) {
      transactions(offset: $offset) {
        block {
          height
        }
        contractActions {
          __typename
          address
          ... on ContractCall {
            entryPoint
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { offset: { identifier: txId } },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const result = (await response.json()) as GraphQLResponse<{
      transactions?: ReadonlyArray<{
        block?: { height?: number };
        contractActions?: ReadonlyArray<{ __typename?: string; address?: string; entryPoint?: string }>;
      }>;
    }>;

    if (result.errors?.length) {
      console.warn("queryTransaction: GraphQL errors:", result.errors);
    }

    const tx = result.data?.transactions?.[0];
    const height = tx?.block?.height;
    if (typeof height !== "number") return null;
    const kinds: Record<string, ContractAction["kind"]> = {
      ContractDeploy: "deploy",
      ContractCall: "call",
      ContractUpdate: "update",
    };
    const contractActions: ContractAction[] = [];
    for (const action of tx?.contractActions ?? []) {
      const kind = kinds[action.__typename ?? ""];
      if (typeof action.address !== "string" || kind === undefined) continue;
      contractActions.push(
        typeof action.entryPoint === "string"
          ? { address: action.address, kind, entryPoint: action.entryPoint }
          : { address: action.address, kind },
      );
    }
    return { blockHeight: height, contractActions };
  } catch (err) {
    console.warn("queryTransaction: could not read the transaction:", err);
    return null;
  }
}

/**
 * Client state - tracks whether we're connected to real network or using mocks.
 */
export interface ClientState {
  connected: boolean;
  network: MidnightNetwork | "mocked";
  providers?: MidnightProviders;
  config?: MidnightConfig;
}

/**
 * Module-level singleton shared by all AgeVerification instances.
 * This is appropriate for single-tenant use; multi-tenant or concurrent
 * contexts (e.g. serverless) would need per-instance state instead.
 */
let clientState: ClientState = {
  connected: false,
  network: "mocked",
};

/**
 * Initialize Midnight client
 *
 * Sets up providers for proof generation and indexer queries.
 * Wallet setup and contract deployment happen per-proof in the age verification flow.
 *
 * @returns true if connected to real network, false if falling back to mocks
 */
export async function initializeClient(config: MidnightConfig = {}): Promise<boolean> {
  const available = await isNetworkAvailable(config);

  if (available) {
    // The state records the endpoints in use, defaults included, so a reader
    // of it (verification, for one) sees the same indexer generation used.
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    clientState = {
      connected: true,
      network: mergedConfig.network ?? "standalone",
      providers: createProviders(mergedConfig),
      config: mergedConfig,
    };
    return true;
  }

  clientState = {
    connected: false,
    network: "mocked",
  };
  return false;
}

/**
 * Get current client state
 */
export function getClientState(): ClientState {
  return { ...clientState };
}

// Re-export Midnight SDK contract utilities for use by proof generators
export { deployContract, findDeployedContract };
export type { DeployedContract, FinalizedTxData };
