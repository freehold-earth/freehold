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
  /** Path to compiled contract assets (managed/ directory) */
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
function buildIndexerUrls(indexerUrl: string): { httpUrl: string; wsUrl: string } {
  const parsed = new URL(indexerUrl);
  const normalisedPath = parsed.pathname.replace(/\/$/, "");
  const alreadyHasEndpoint =
    normalisedPath.endsWith("/api/v4/graphql") ||
    normalisedPath.endsWith("/api/v3/graphql");

  const http = new URL(parsed.href);
  if (!alreadyHasEndpoint) {
    const base = http.href.endsWith("/") ? http.href : `${http.href}/`;
    http.href = new URL("api/v4/graphql", base).href;
  }

  const ws = new URL(http.href);
  ws.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  if (!ws.pathname.endsWith("/ws")) {
    ws.pathname = `${ws.pathname}/ws`;
  }

  return { httpUrl: http.href, wsUrl: ws.href };
}

/**
 * Create Midnight providers for contract interaction
 */
export function createProviders(config: MidnightConfig = {}): MidnightProviders {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Note: proofProvider requires zkConfigProvider (compiled contract assets),
  // so it's created per-deployment in the proof generation flow, not here.
  const { httpUrl, wsUrl } = buildIndexerUrls(mergedConfig.indexerUrl);
  const publicDataProvider = indexerPublicDataProvider(httpUrl, wsUrl);

  return {
    publicDataProvider,
  };
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
      fetch(`${mergedConfig.proofServerUrl}/health`, {
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

/**
 * The circuit's ledger for a contract, as the chain holds it now.
 *
 * The indexer serves the contract's latest state serialized; the public data
 * provider deserializes it and the compiled contract names its fields, so the
 * fields come back as the circuit declared them (`requesterCommitment` as the
 * 32 bytes the circuit wrote). Null when the contract is unknown to the
 * indexer or the read fails; a failure is logged.
 */
export async function queryContractState(
  indexerUrl: string,
  contractAddress: string,
  contractAssetsPath?: string,
): Promise<Record<string, unknown> | null> {
  const { httpUrl, wsUrl } = buildIndexerUrls(indexerUrl);
  try {
    const state = await indexerPublicDataProvider(httpUrl, wsUrl).queryContractState(contractAddress);
    if (state === null) return null;
    const { ledger } = await loadContractModule(resolveContractAssetsPath(contractAssetsPath));
    return { ...ledger(state.data) };
  } catch (err) {
    console.warn("queryContractState: could not read the contract's ledger:", err);
    return null;
  }
}

/**
 * The block a transaction was included in and the contracts it acted on, by
 * the transaction identifier a finalized transaction reports; null when the
 * indexer does not know it. GraphQL-level errors are logged for diagnostics.
 */
export async function queryTransaction(
  indexerUrl: string,
  txId: string,
): Promise<{ blockHeight: number; contractAddresses: string[] } | null> {
  const { httpUrl } = buildIndexerUrls(indexerUrl);

  const query = `
    query Transaction($offset: TransactionOffset!) {
      transactions(offset: $offset) {
        block {
          height
        }
        contractActions {
          address
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
        contractActions?: ReadonlyArray<{ address?: string }>;
      }>;
    }>;

    if (result.errors?.length) {
      console.warn("queryTransaction: GraphQL errors:", result.errors);
    }

    const tx = result.data?.transactions?.[0];
    const height = tx?.block?.height;
    if (typeof height !== "number") return null;
    const contractAddresses = (tx?.contractActions ?? [])
      .map((action) => action.address)
      .filter((address): address is string => typeof address === "string");
    return { blockHeight: height, contractAddresses };
  } catch {
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
    clientState = {
      connected: true,
      network: config.network ?? "standalone",
      providers: createProviders(config),
      config,
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
