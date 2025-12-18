/**
 * Lucid Evolution Provider Module
 *
 * Provides initialization and configuration for Lucid Evolution SDK.
 * Supports multiple providers: Kupmios (Yaci devnet), Blockfrost (testnets/mainnet).
 */

import { Lucid, Kupmios, Blockfrost, type LucidEvolution } from "@lucid-evolution/lucid";
import type { LucidConfig, Network } from "../types.js";

/**
 * Initialize Lucid with the appropriate provider based on configuration
 *
 * @param config - Lucid configuration
 * @returns Initialized Lucid instance
 */
export async function initializeLucid(config: LucidConfig): Promise<LucidEvolution> {
  const provider = createProvider(config);

  // Map our network type to Lucid network type
  const network = mapNetwork(config.network);

  const lucid = await Lucid(provider, network);

  return lucid;
}

/**
 * Create the appropriate provider based on configuration
 */
function createProvider(config: LucidConfig) {
  // Kupmios provider for local devnet (Yaci)
  if (config.providerUrl.includes("localhost") || config.providerUrl.includes("127.0.0.1")) {
    // Kupmios expects ogmios and kupo endpoints
    // For Yaci devkit, typically: http://localhost:1337 (ogmios), http://localhost:1442 (kupo)
    const kupoUrl = config.providerUrl.replace(":1337", ":1442");
    return new Kupmios(config.providerUrl, kupoUrl);
  }

  // Blockfrost provider for testnets/mainnet
  if (!config.apiKey) {
    throw new Error("Blockfrost API key required for non-local networks");
  }

  return new Blockfrost(config.providerUrl, config.apiKey);
}

/**
 * Map our Network type to Lucid's network string
 */
function mapNetwork(network: Network): "Mainnet" | "Preprod" | "Preview" | "Custom" {
  switch (network) {
    case "Mainnet":
      return "Mainnet";
    case "Preprod":
      return "Preprod";
    case "Preview":
      return "Preview";
    case "Custom":
      return "Custom";
    default:
      throw new Error(`Unknown network: ${network}`);
  }
}

/**
 * Load wallet from seed phrase
 *
 * @param lucid - Lucid instance
 * @param seedPhrase - 24-word seed phrase
 * @returns Lucid instance with wallet selected
 */
export function selectWalletFromSeed(lucid: LucidEvolution, seedPhrase: string): LucidEvolution {
  lucid.selectWallet.fromSeed(seedPhrase);
  return lucid;
}

/**
 * Load wallet from private key
 *
 * @param lucid - Lucid instance
 * @param privateKey - Private key (hex or bech32)
 * @returns Lucid instance with wallet selected
 */
export function selectWalletFromPrivateKey(lucid: LucidEvolution, privateKey: string): LucidEvolution {
  lucid.selectWallet.fromPrivateKey(privateKey);
  return lucid;
}

/**
 * Get default configuration for different networks
 */
export function getDefaultConfig(network: Network): LucidConfig {
  switch (network) {
    case "Custom":
      // Yaci devkit default endpoints
      return {
        network: "Custom",
        providerUrl: "http://localhost:1337",
        networkMagic: 764824073, // Yaci default
      };
    case "Preview":
      return {
        network: "Preview",
        providerUrl: "https://cardano-preview.blockfrost.io/api/v0",
      };
    case "Preprod":
      return {
        network: "Preprod",
        providerUrl: "https://cardano-preprod.blockfrost.io/api/v0",
      };
    case "Mainnet":
      return {
        network: "Mainnet",
        providerUrl: "https://cardano-mainnet.blockfrost.io/api/v0",
      };
    default:
      throw new Error(`Unknown network: ${network}`);
  }
}
