/**
 * Midnight HD Wallet Management
 *
 * Creates and manages HD wallets for Midnight ZK proof transactions.
 * Handles seed management, key derivation, and wallet facade lifecycle.
 *
 * Based on the official counter example patterns (midnightntwrk/example-counter).
 *
 * Security: seed buffers are zeroed after HD derivation; seeds are never logged.
 */

import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { WalletFacade, WalletEntrySchema } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import {
  DustAddress,
  MidnightBech32m,
  UnshieldedAddress,
} from "@midnight-ntwrk/wallet-sdk-address-format";
import {
  ZswapSecretKeys,
  DustSecretKey,
  LedgerParameters,
  nativeToken,
  type DustPublicKey,
} from "@midnight-ntwrk/ledger-v8";
import { getNetworkId, setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as Rx from "rxjs";
import type { MidnightNetwork } from "./client.js";
import type { WalletProvider, MidnightProvider } from "@midnight-ntwrk/midnight-js-types";

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

export interface DerivedKeys {
  zswapSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  /** Derived key seeds indexed by role */
  keys: Record<number, Uint8Array>;
}

export interface ManagedWallet {
  facade: WalletFacade;
  /** The network the wallet was created for */
  network: MidnightNetwork;
  zswapSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
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
 * Map a MidnightNetwork to the network ID expected by wallet SDK internals.
 * Standalone uses "undeployed" per the official counter example.
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

/** The bech32m unshielded (NIGHT) address (`mn_addr…`) of a derived NIGHT key on `network`. */
export function formatNightAddress(network: MidnightNetwork, nightKey: Uint8Array): string {
  const copy = Uint8Array.from(nightKey);
  try {
    return createKeystore(copy, networkToId(network)).getBech32Address().asString();
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
 * Derive HD wallet keys from a hex seed.
 *
 * Uses BIP-44-style derivation: account 0, roles [Zswap, NightExternal, Dust], index 0.
 * The seed buffer is zeroed after derivation.
 */
export function deriveKeys(seedHex: string): DerivedKeys {
  const seedBytes = Buffer.from(seedHex, "hex");
  let hdWallet: { clear(): void } | null = null;

  try {
    const result = HDWallet.fromSeed(seedBytes);

    if (result.type !== "seedOk") {
      throw new Error("Failed to initialize HDWallet from seed");
    }

    hdWallet = result.hdWallet;

    const derived = result.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
      .deriveKeysAt(0);

    if (derived.type !== "keysDerived") {
      throw new Error("Failed to derive keys");
    }

    const zswapSecretKeys = ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
    const dustSecretKey = DustSecretKey.fromSeed(derived.keys[Roles.Dust]);

    return { zswapSecretKeys, dustSecretKey, keys: derived.keys };
  } finally {
    seedBytes.fill(0);
    hdWallet?.clear();
  }
}

/**
 * Build a merged Midnight wallet configuration for the `WalletFacade.init`
 * factory. All three sub-wallets (shielded, unshielded, Dust) now require
 * a `txHistoryStorage` (previously unshielded-only), so the object below
 * intentionally supplies one at the top level.
 *
 * NOTE: With wallet-sdk 4.x, `DefaultConfiguration` is an intersection of
 * per-wallet default configuration types whose exact shape shifts between
 * canary/patch releases. The typing here is intentionally loose (`unknown`
 * cast at the `WalletFacade.init` call site) so that the SDK bump does not
 * become a full facade-configuration refactor. Runtime correctness of this
 * config against a real network needs live verification when the local
 * stack is up (see the infra Ledger 8 refresh).
 */
function buildFacadeConfig(config: WalletConfig) {
  const indexerClientConnection = {
    indexerHttpUrl: config.indexerUrl,
    indexerWsUrl: config.indexerWsUrl,
  };
  const provingServerUrl = new URL(config.proofServerUrl);
  const relayURL = new URL(ensureWsProtocol(config.nodeUrl));

  return {
    networkId: networkToId(config.network),
    indexerClientConnection,
    provingServerUrl,
    relayURL,
    // Cost parameters from official counter example (midnightntwrk/example-counter).
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    // In-memory transaction history — the ephemeral, single-use wallets
    // used for ZK proof generation do not require persistent history.
    // WalletEntrySchema is the canonical merged shielded/unshielded/dust
    // entry shape exported by wallet-sdk-facade.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
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
  const secrets = { shieldedSecretKeys: wallet.zswapSecretKeys, dustSecretKey: wallet.dustSecretKey };
  const ttl = new Date(Date.now() + 30 * 60 * 1000);
  const transfer = await wallet.facade.transferTransaction(
    [{ type: "unshielded", outputs: [{ type: nativeToken().raw, receiverAddress, amount }] }],
    secrets,
    { ttl, payFees: false },
  );
  const balanced = await wallet.facade.balanceUnprovenTransaction(transfer.transaction, secrets, {
    ttl,
    tokenKindsToBalance: ["dust"],
  });
  const signed = await wallet.facade.signRecipe(balanced, (payload) =>
    wallet.unshieldedKeystore.signData(payload),
  );
  const finalized = await wallet.facade.finalizeRecipe(signed);
  return String(await wallet.facade.submitTransaction(finalized));
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

/** Whether the wallet SDK refused an operation because the wallet cannot cover it. */
function isInsufficientFunds(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _tag?: unknown })._tag === "Wallet.InsufficientFunds"
  );
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
 * NOTE (wallet-sdk 4.x migration): the private-constructor rework of
 * `WalletFacade` and the associated recipe/signing surface changed shape
 * substantially. The pre-`proof`/`pre-proof` intent-cloning workaround
 * from wallet-sdk 1.0.0 should be obsolete in 4.0.1 — the facade now
 * exposes a first-class `signRecipe(recipe, signSegment)` method. We use
 * that path here, but the exact ordering/segmentation still needs live
 * verification against a running Ledger 8 stack.
 */
export async function createWalletAndMidnightProvider(
  wallet: ManagedWallet,
): Promise<ProofProviders> {
  const state = await wallet.facade.waitForSyncedState();

  const signFn = (payload: Uint8Array) => wallet.unshieldedKeystore.signData(payload);
  const dustFees: bigint[] = [];

  return {
    dustFees,
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx, ttl?) {
      const deadline = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
      const available = await wallet.dustBalance();
      // The estimate itself is a balancing dry run, so a wallet that cannot
      // cover the fee is refused there rather than reporting a number
      let fee: bigint;
      try {
        fee = await wallet.facade.estimateTransactionFee(tx, wallet.dustSecretKey, {
          ttl: deadline,
        });
      } catch (err) {
        if (isInsufficientFunds(err)) throw new DustCapacityError(wallet.dustAddress, available);
        throw err;
      }
      if (available < fee) {
        throw new DustCapacityError(wallet.dustAddress, available, fee);
      }

      let recipe: Awaited<ReturnType<typeof wallet.facade.balanceUnboundTransaction>>;
      try {
        recipe = await wallet.facade.balanceUnboundTransaction(
          tx,
          {
            shieldedSecretKeys: wallet.zswapSecretKeys,
            dustSecretKey: wallet.dustSecretKey,
          },
          { ttl: deadline },
        );
      } catch (err) {
        if (isInsufficientFunds(err)) throw new DustCapacityError(wallet.dustAddress, available, fee);
        throw err;
      }

      // wallet-sdk 4.x: use the facade's first-class signRecipe path.
      const signed = await wallet.facade.signRecipe(recipe, signFn);
      const finalized = await wallet.facade.finalizeRecipe(signed);
      dustFees.push(fee);
      return finalized;
    },
    submitTx(tx) {
      return wallet.facade.submitTransaction(tx) as Promise<string>;
    },
  };
}

/**
 * The process-wide network id, or undefined before one is set. The SDK's
 * getter throws in that case rather than returning undefined.
 */
function configuredNetworkId(): string | undefined {
  try {
    return getNetworkId();
  } catch {
    return undefined;
  }
}

/**
 * Create a fully configured ManagedWallet.
 *
 * Uses the wallet-sdk 4.x `WalletFacade.init` factory: it wires the three
 * sub-wallets (shielded, unshielded, Dust) plus default submission /
 * pending-tx / proving services, and returns a started facade.
 *
 * @remarks
 * The wallet-sdk 4.x configuration surface uses effect/Schema-heavy
 * generic types whose exact shape moves between canary/patch releases.
 * The `configuration` object is intentionally passed through an `unknown`
 * cast at the boundary — this is a pragmatic bridge for the SDK bump.
 * Full type-safe wiring plus a live-network smoke test is tracked as a
 * follow-up to the SDK version bump.
 */
export async function createWallet(config: WalletConfig): Promise<ManagedWallet> {
  const seedHex = resolveSeed(config);
  const { zswapSecretKeys, dustSecretKey, keys } = deriveKeys(seedHex);

  // Set network ID globally (required by wallet-sdk internals — single network per process)
  const desiredNetworkId = networkToId(config.network);
  const currentNetworkId = configuredNetworkId();
  if (currentNetworkId !== undefined && currentNetworkId !== desiredNetworkId) {
    throw new Error(
      `Global network ID is already set to "${currentNetworkId}", which differs from requested "${desiredNetworkId}". ` +
        "Multiple different Midnight networks in a single process are not supported."
    );
  }
  setNetworkId(desiredNetworkId);

  // The keystore keeps the buffer it is given and reads it on every signing
  // call, so it gets a copy of its own that lives as long as the wallet.
  const nightSigningKey = Uint8Array.from(keys[Roles.NightExternal]);
  const unshieldedKeystore = createKeystore(nightSigningKey, getNetworkId());

  // Zero the derived key buffers now that ZswapSecretKeys and DustSecretKey
  // have copied theirs and the keystore has its own copy.
  for (const role of Object.keys(keys)) {
    const buf = keys[Number(role)];
    if (buf instanceof Uint8Array) buf.fill(0);
  }

  const configuration = buildFacadeConfig(config);

  // Capture sub-wallet handles so we can query addresses after init.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let shieldedHandle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let unshieldedHandle: any;

  // See @remarks above for the rationale for the `unknown` cast on init.
  const facade = await WalletFacade.init({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configuration: configuration as any,
    shielded: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      shieldedHandle = ShieldedWallet(configuration as any).startWithSecretKeys(zswapSecretKeys);
      return shieldedHandle;
    },
    unshielded: () => {
      unshieldedHandle = UnshieldedWallet(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configuration as any,
      ).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
      return unshieldedHandle;
    },
    dust: () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      DustWallet(configuration as any).startWithSecretKey(
        dustSecretKey,
        LedgerParameters.initialParameters().dust,
      ),
  });

  try {
    // init only builds the facade; start is what connects the three
    // sub-wallets to the indexer and begins syncing
    await facade.start(zswapSecretKeys, dustSecretKey);

    const shieldedAddr = await shieldedHandle.getAddress();
    const unshieldedAddr = await unshieldedHandle.getAddress();

    return {
      facade,
      network: config.network,
      zswapSecretKeys,
      dustSecretKey,
      unshieldedKeystore,
      shieldedAddress: shieldedAddr.coinPublicKeyString(),
      unshieldedAddress: unshieldedAddr.hexString,
      dustAddress: formatDustAddress(config.network, dustSecretKey.publicKey),

      async stop() {
        try {
          await facade.stop();
        } finally {
          zswapSecretKeys.clear();
          dustSecretKey.clear();
          nightSigningKey.fill(0);
        }
      },

      async waitForSync(timeoutMs = 60_000) {
        await Rx.firstValueFrom(
          facade.state().pipe(
            Rx.throttleTime(2_000),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Rx.filter((state: any) => state.isSynced),
            Rx.timeout(timeoutMs),
          ),
        );
      },

      async dustBalance(at = new Date()) {
        // A snapshot taken mid-sync could show nothing yet
        const state = await facade.waitForSyncedState();
        return state.dust.balance(at);
      },
    };
  } catch (err) {
    try {
      await facade.stop().catch(() => {});
    } finally {
      zswapSecretKeys.clear();
      dustSecretKey.clear();
      nightSigningKey.fill(0);
    }
    throw err;
  }
}

// Module-level singleton with pending-promise guard.
// Only one network per process is supported — setNetworkId() is a global side effect.
let walletInstance: ManagedWallet | null = null;
let walletPending: Promise<ManagedWallet> | null = null;
let walletNetwork: string | null = null;

/**
 * Get or create a singleton wallet instance.
 *
 * Uses a pending-promise guard to prevent duplicate wallet creation
 * when multiple callers invoke this concurrently.
 *
 * Only one network per process is supported (setNetworkId is global).
 * Throws if called with a different network than the existing wallet.
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
