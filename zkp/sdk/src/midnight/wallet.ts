/**
 * Midnight HD Wallet Management
 *
 * Creates and manages HD wallets for Midnight ZK proof transactions.
 * Handles seed management, key derivation, and wallet facade lifecycle.
 *
 * Follows the wallet SDK's own snippets: one master seed becomes a seed per
 * wallet, and the wallets derive their keys from those.
 *
 * Security: the master seed is zeroed after derivation and the per-wallet
 * seeds as soon as the wallets have started; seeds are never logged. The
 * keys the wallet SDK derives from them are its own to hold and it offers no
 * way to clear them, so they live as long as the wallet objects do.
 */

import {
  createKeystore,
  DustAddress,
  DustWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  MidnightBech32m,
  PublicKey,
  ShieldedWallet,
  Token,
  UnshieldedAddress,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
  WalletSeeds,
  type DefaultConfiguration,
  type UnshieldedKeystore,
} from "@midnightntwrk/wallet-sdk";
import type { DustPublicKey } from "@midnightntwrk/wallet-sdk/ledger/v9";
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type MidnightProvider,
  type WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import * as Rx from "rxjs";
import type { MidnightNetwork } from "./client.js";

export interface WalletConfig {
  /** Hex-encoded wallet seed (64+ hex chars = 32+ bytes) */
  seed?: string;
  /** Target network */
  network: MidnightNetwork;
  /** Indexer GraphQL HTTP URL (with /api/v4/graphql path) */
  indexerUrl: string;
  /** Indexer GraphQL WebSocket URL (with /api/v4/graphql/ws path) */
  indexerWsUrl: string;
  /** Midnight node WebSocket URL (ws:// or wss://) for relay */
  nodeUrl: string;
  /** Proof server URL */
  proofServerUrl: string;
}

/**
 * The seeds the three wallets start from, one each for the shielded, the
 * unshielded (NIGHT) and the DUST wallet. Each wallet derives its own keys
 * from its seed, so no key object is held here.
 */
export type DerivedKeys = WalletSeeds;

export interface ManagedWallet {
  facade: WalletFacade;
  /** The network the wallet was created for */
  network: MidnightNetwork;
  unshieldedKeystore: UnshieldedKeystore;
  shieldedAddress: string;
  unshieldedAddress: string;
  /**
   * The wallet's DUST address (bech32m, `mn_dust…`): where a sponsor points
   * DUST generation so this wallet can pay proof fees.
   */
  dustAddress: string;
  stop(): Promise<void>;
  waitForSync(timeoutMs?: number): Promise<void>;
  /** DUST available to pay fees at `at` (now by default), in specks, once the wallet is synced. */
  dustBalance(at?: Date): Promise<bigint>;
}

/**
 * Map a MidnightNetwork to the network ID the wallet SDK and Midnight.js
 * take. A standalone chain calls itself "undeployed".
 */
export function networkToId(network: MidnightNetwork): string {
  switch (network) {
    case "standalone":
      return "undeployed";
    case "testnet":
      return "testnet";
    case "preview":
      return "preview";
    case "preprod":
      return "preprod";
    case "mainnet":
      return "mainnet";
  }
}

/**
 * The bech32m form of a DUST public key on `network` (`mn_dust…`, or
 * `mn_dust_<network>…` off mainnet).
 */
export function formatDustAddress(network: MidnightNetwork, publicKey: DustPublicKey): string {
  return DustAddress.encodePublicKey(networkToId(network), publicKey);
}

/**
 * Parse a bech32m DUST address for `network`.
 *
 * @throws Error when the text is not a DUST address, or is one for another network
 */
export function parseDustAddress(address: string, network: MidnightNetwork): DustAddress {
  return MidnightBech32m.parse(address).decode(DustAddress, networkToId(network));
}

/** The bech32m unshielded (NIGHT) address (`mn_addr…`) of an unshielded seed on `network`. */
export function formatNightAddress(network: MidnightNetwork, nightKey: Uint8Array): string {
  const copy = Uint8Array.from(nightKey);
  try {
    return createKeystore({ kind: "schnorr", secret: copy }, networkToId(network))
      .getBech32Address()
      .asString();
  } finally {
    copy.fill(0);
  }
}

/**
 * Parse a bech32m unshielded (NIGHT) address for `network`.
 *
 * @throws Error when the text is not an unshielded address, or is one for another network
 */
export function parseNightAddress(address: string, network: MidnightNetwork): UnshieldedAddress {
  return MidnightBech32m.parse(address).decode(UnshieldedAddress, networkToId(network));
}

/**
 * Resolve the wallet seed from config, env, or random generation.
 *
 * Priority: config.seed > MIDNIGHT_WALLET_SEED env var > random (non-mainnet only).
 * Mainnet always requires an explicit seed — random seeds would lose funds.
 *
 * @throws Error if mainnet and no seed provided
 * @throws Error if seed is not valid hex or too short (< 64 hex chars = 32 bytes)
 */
export function resolveSeed(config: Pick<WalletConfig, "seed" | "network">): string {
  const seed = config.seed || process.env.MIDNIGHT_WALLET_SEED;

  if (seed) {
    const trimmed = seed.trim();
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      throw new Error("Wallet seed must be a hex string");
    }
    if (trimmed.length % 2 !== 0) {
      throw new Error("Wallet seed must have an even number of hex characters (each byte is 2 hex chars)");
    }
    if (trimmed.length < 64) {
      throw new Error("Wallet seed must be at least 32 bytes (64 hex characters)");
    }
    return trimmed;
  }

  if (config.network === "mainnet") {
    throw new Error(
      "Mainnet requires an explicit wallet seed (config.seed or MIDNIGHT_WALLET_SEED env var). " +
        "Random seeds are disabled on mainnet to prevent fund loss."
    );
  }

  // Generate random seed for non-mainnet
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive the three wallets' seeds from a hex master seed.
 *
 * The first account and address of the HD tree, with the unshielded seed
 * taken from the NightExternal role. The master seed buffer is zeroed after
 * derivation; the caller owns the returned seeds and zeroes them when done.
 */
export function deriveKeys(seedHex: string): DerivedKeys {
  const seedBytes = Buffer.from(seedHex, "hex");
  try {
    return WalletSeeds.fromMasterSeed(seedBytes);
  } finally {
    seedBytes.fill(0);
  }
}

/** How long a transaction built here stays valid. */
export const TRANSACTION_TTL_MS = 30 * 60 * 1000;

/** The time a transaction built now stops being valid. */
export function transactionTtl(): Date {
  return new Date(Date.now() + TRANSACTION_TTL_MS);
}

/** The configuration the facade and its three wallets are built from. */
function buildFacadeConfig(config: WalletConfig): DefaultConfiguration {
  return {
    networkId: networkToId(config.network),
    indexerClientConnection: {
      indexerHttpUrl: config.indexerUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    // One proof server for every ledger version: the networks this runs
    // against are on Ledger 9, so no transaction is ever proved for Ledger 8.
    provingServerUrl: new URL(config.proofServerUrl),
    relayURL: new URL(ensureWsProtocol(config.nodeUrl)),
    costParameters: { feeBlocksMargin: 5 },
    // History is kept in memory: the wallet lives for one process and
    // nothing reads its history after that.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  };
}

/**
 * Ensure a URL uses WebSocket protocol (ws:// or wss://).
 * Accepts ws://, wss://, http://, or https:// and normalizes to ws(s).
 */
function ensureWsProtocol(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.href;
}

/**
 * Send NIGHT from `wallet` to a bech32m unshielded address (`mn_addr…`),
 * paying the fee from the wallet's DUST. `amount` is in STAR, of which a
 * NIGHT has a million. This is how a sponsor wallet is funded.
 *
 * @returns the transaction id
 * @throws Error when the address is not an unshielded address for the
 *   wallet's network, or when the network refuses the transfer
 */
export async function transferNight(
  wallet: ManagedWallet,
  toAddress: string,
  amount: bigint,
): Promise<string> {
  const receiverAddress = parseNightAddress(toAddress, wallet.network);
  const ttl = transactionTtl();
  const transfer = await wallet.facade.transferTransaction(
    [{ type: "unshielded", outputs: [{ type: Token.night, receiverAddress, amount }] }],
    { ttl, payFees: false },
  );
  const balanced = await wallet.facade.balanceUnprovenTransaction(transfer.transaction, {
    ttl,
    tokenKindsToBalance: ["dust"],
  });
  const signed = await wallet.facade.signRecipe(balanced, wallet.unshieldedKeystore.signDataAsync);
  const finalized = await wallet.facade.finalizeRecipe(signed);
  return wallet.facade.submitTransaction(finalized);
}

/**
 * Thrown before a transaction is balanced when the wallet cannot pay its
 * DUST fee. Names the address a sponsor designates DUST generation to.
 */
export class DustCapacityError extends Error {
  constructor(
    readonly dustAddress: string,
    readonly available: bigint,
    readonly required?: bigint,
  ) {
    super(
      `${
        required !== undefined
          ? `The wallet holds ${available} specks of DUST but the transaction needs ${required}`
          : available === 0n
            ? "The wallet holds no DUST to pay proof fees"
            : `The wallet holds ${available} specks of DUST, which cannot cover the transaction's fee`
      }; sponsor DUST generation to ${dustAddress}`,
    );
    this.name = "DustCapacityError";
  }
}

/**
 * The providers a proof flow needs, plus the DUST fee of every transaction
 * they balanced. The list belongs to one set of providers, so a flow that
 * wants its own total creates its own providers rather than sharing them.
 */
export type ProofProviders = WalletProvider &
  MidnightProvider & {
    /** Fees in specks as estimated before balancing, one per balanced transaction, in order */
    readonly dustFees: readonly bigint[];
  };

/**
 * Whether the wallet SDK refused an operation because the wallet cannot
 * cover it. The SDK runs on Effect, whose promise rejects with a wrapper
 * around the failure, not the failure itself: the tag is read from the
 * wrapper's JSON form, and from the error directly for a failure that
 * arrives bare.
 */
function isInsufficientFunds(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const bare = (err as { _tag?: unknown })._tag;
  const wrapped =
    typeof (err as { toJSON?: unknown }).toJSON === "function"
      ? (err as { toJSON(): { cause?: { failure?: { _tag?: unknown } } } }).toJSON()?.cause?.failure?._tag
      : undefined;
  return bare === "Wallet.InsufficientFunds" || wrapped === "Wallet.InsufficientFunds";
}

/**
 * Create a WalletProvider & MidnightProvider from a ManagedWallet.
 *
 * This provider bridges the wallet facade into the midnight-js-contracts
 * provider interface, handling balancing, signing, and submission. Before
 * a transaction is balanced its DUST fee is estimated and checked against
 * the wallet's balance, so a wallet without capacity fails with a
 * DustCapacityError naming its address rather than at submission.
 *
 * Midnight.js and the wallet SDK each carry a transaction in a handle of
 * their own, and neither reads the other's, so a transaction crosses between
 * them as bytes. The providers serve Ledger 9 only: Midnight.js refuses a
 * Ledger 8 transaction before it reaches the wallet.
 */
export async function createWalletAndMidnightProvider(
  wallet: ManagedWallet,
): Promise<ProofProviders> {
  const state = await wallet.facade.waitForSyncedState();
  const dustFees: bigint[] = [];

  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl) {
      const deadline = ttl ?? transactionTtl();
      const unbound = wallet.facade.adoptTransaction(tx.serialize(), "Unbound");
      const available = await wallet.dustBalance();
      // The estimate itself is a balancing dry run, so a wallet that cannot
      // cover the fee is refused there rather than reporting a number
      let fee: bigint;
      try {
        fee = await wallet.facade.estimateTransactionFee(unbound, { ttl: deadline });
      } catch (err) {
        if (isInsufficientFunds(err)) throw new DustCapacityError(wallet.dustAddress, available);
        throw err;
      }
      if (available < fee) {
        throw new DustCapacityError(wallet.dustAddress, available, fee);
      }

      let recipe: Awaited<ReturnType<typeof wallet.facade.balanceUnboundTransaction>>;
      try {
        recipe = await wallet.facade.balanceUnboundTransaction(unbound, { ttl: deadline });
      } catch (err) {
        if (isInsufficientFunds(err)) throw new DustCapacityError(wallet.dustAddress, available, fee);
        throw err;
      }

      const signed = await wallet.facade.signRecipe(recipe, wallet.unshieldedKeystore.signDataAsync);
      const finalized = await wallet.facade.finalizeRecipe(signed);
      dustFees.push(fee);
      return finalized.serialize();
    },
  });
  const midnightProvider = createLedger9MidnightProvider((tx) =>
    wallet.facade.submitTransaction(wallet.facade.adoptTransaction(tx.serialize(), "Finalized")),
  );

  return {
    dustFees,
    supportedEras: walletProvider.supportedEras,
    getCoinPublicKey: () => walletProvider.getCoinPublicKey(),
    getEncryptionPublicKey: () => walletProvider.getEncryptionPublicKey(),
    balanceTx: (tx, ttl) => walletProvider.balanceTx(tx, ttl),
    submitTx: (tx) => midnightProvider.submitTx(tx),
  };
}

/**
 * Create a fully configured ManagedWallet: the facade over the shielded,
 * unshielded and DUST wallets, started and syncing.
 */
export async function createWallet(config: WalletConfig): Promise<ManagedWallet> {
  const seeds = deriveKeys(resolveSeed(config));
  // The keystore copies its secret when it is made and the wallets derive
  // their keys when they start, so the seeds are needed only until then.
  const zeroSeeds = () => {
    seeds.shielded.fill(0);
    seeds.unshielded.fill(0);
    seeds.dust.fill(0);
  };

  let facade: WalletFacade | undefined;
  try {
    const networkId = networkToId(config.network);
    const unshieldedKeystore = createKeystore({ kind: "schnorr", secret: seeds.unshielded }, networkId);

    facade = await WalletFacade.init({
      configuration: buildFacadeConfig(config),
      shielded: (resolved) => ShieldedWallet(resolved).startWithSeed(seeds.shielded),
      unshielded: (resolved) =>
        UnshieldedWallet(resolved).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
      dust: (resolved) => DustWallet(resolved).startWithSeed(seeds.dust),
    });
    const started = facade;

    // init only builds the facade; start is what connects the three
    // sub-wallets to the indexer and begins syncing
    await started.start(seeds);
    zeroSeeds();

    const [shieldedAddress, unshieldedAddress, dustAddress] = await Promise.all([
      started.shielded.getAddress(),
      started.unshielded.getAddress(),
      started.dust.getAddress(),
    ]);

    return {
      facade: started,
      network: config.network,
      unshieldedKeystore,
      shieldedAddress: shieldedAddress.coinPublicKeyString(),
      unshieldedAddress: unshieldedAddress.hexString,
      dustAddress: MidnightBech32m.encode(networkId, dustAddress).asString(),

      async stop() {
        await started.stop();
      },

      async waitForSync(timeoutMs = 60_000) {
        await Rx.firstValueFrom(
          started.state().pipe(
            Rx.throttleTime(2_000),
            Rx.filter((state) => state.isSynced),
            Rx.timeout(timeoutMs),
          ),
        );
      },

      async dustBalance(at = new Date()) {
        // A snapshot taken mid-sync could show nothing yet
        const state = await started.waitForSyncedState();
        return state.dust.balance(at);
      },
    };
  } catch (err) {
    try {
      await facade?.stop().catch(() => {});
    } finally {
      zeroSeeds();
    }
    throw err;
  }
}

// Module-level singleton with pending-promise guard. It holds one wallet,
// and a wallet belongs to one network, so the process serves one network at
// a time.
let walletInstance: ManagedWallet | null = null;
let walletPending: Promise<ManagedWallet> | null = null;
let walletNetwork: string | null = null;

/**
 * Get or create a singleton wallet instance.
 *
 * Uses a pending-promise guard to prevent duplicate wallet creation
 * when multiple callers invoke this concurrently.
 *
 * Throws if called with a different network than the existing wallet's;
 * destroyWallet() first to switch.
 */
export async function getOrCreateWallet(config: WalletConfig): Promise<ManagedWallet> {
  if (walletInstance || walletPending) {
    if (walletNetwork && walletNetwork !== config.network) {
      throw new Error(
        `Wallet already initialized for network "${walletNetwork}". ` +
          `Cannot switch to "${config.network}" — only one network per process is supported. ` +
          `Call destroyWallet() first to switch networks.`
      );
    }
    if (walletInstance) return walletInstance;
    return walletPending!;
  }

  walletNetwork = config.network;
  // Publish the wallet only if nothing destroyed the singleton while it was
  // being created; destroyWallet stops it in that case
  const creation: Promise<ManagedWallet> = createWallet(config)
    .then((wallet) => {
      if (walletPending === creation) {
        walletInstance = wallet;
        walletPending = null;
      }
      return wallet;
    })
    .catch((err) => {
      if (walletPending === creation) {
        walletPending = null;
        walletNetwork = null;
      }
      throw err;
    });
  walletPending = creation;

  return creation;
}

/**
 * The singleton wallet if one has been created, without creating one.
 */
export function getExistingWallet(): ManagedWallet | null {
  return walletInstance;
}

/**
 * Destroy the singleton wallet (for tests and cleanup).
 */
export async function destroyWallet(): Promise<void> {
  // Forget the wallet before stopping it, so nothing hands out a wallet
  // that is on its way down
  const pending = walletPending;
  const instance = walletInstance;
  walletInstance = null;
  walletPending = null;
  walletNetwork = null;

  let alreadyStopped = false;
  if (pending) {
    try {
      const wallet = await pending;
      await wallet.stop();
      alreadyStopped = true;
    } catch {
      // Ignore errors during cleanup
    }
  }
  if (!alreadyStopped && instance) {
    await instance.stop();
  }
}
