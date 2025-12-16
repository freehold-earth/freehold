/**
 * Midnight Shielded Funding Types
 *
 * These interfaces define the funding flow for ephemeral wallets
 * using Midnight's privacy-preserving transactions.
 *
 * The goal is to break the on-chain link between a user's main wallet
 * and their ephemeral wallets used for private transactions.
 *
 * Flow:
 * 1. User has main wallet (Cardano) with ADA
 * 2. User shields funds into Midnight pool (breaks link)
 * 3. User unshields to ephemeral wallet (fresh address)
 * 4. Ephemeral wallet pays for ephemeral DID operations
 *
 * Privacy: On-chain observers cannot link main wallet to ephemeral wallet
 * Provability: User CAN prove the link via ZK proof when needed (legal/audit)
 *
 * See: pci-docs/PCI_Identity_Privacy_Model.md for full specification
 */

/**
 * Represents a Cardano wallet address
 */
export interface CardanoAddress {
  /** Bech32 encoded address (addr1...) */
  address: string;
  /** Network tag (mainnet = 1, testnet = 0) */
  networkId: number;
}

/**
 * Represents a shielded balance in Midnight
 *
 * The actual balance is hidden; only the user knows it.
 * ZK proofs verify sufficient balance without revealing amount.
 */
export interface ShieldedBalance {
  /** Commitment to the balance (public) */
  commitment: Uint8Array;
  /** Nullifier for double-spend prevention (revealed on spend) */
  nullifier: Uint8Array;
  /** Secret witness data (private, never shared) */
  witness: ShieldedWitness;
}

/**
 * Private witness data for shielded balance
 * This is NEVER shared - only used locally for ZK proofs
 */
export interface ShieldedWitness {
  /** Actual balance amount (in lovelace) */
  amount: bigint;
  /** Blinding factor for commitment */
  blinding: Uint8Array;
  /** Merkle proof of inclusion in shielded pool */
  merkleProof: Uint8Array[];
}

/**
 * An ephemeral wallet created from shielded funds
 */
export interface EphemeralWallet {
  /** Fresh Cardano address */
  address: CardanoAddress;
  /** Public key for this wallet */
  publicKey: Uint8Array;
  /** Private key (stored encrypted) */
  privateKey: Uint8Array;
  /** Reference to the unshield transaction */
  fundingTxHash: string;
  /** Timestamp of creation */
  createdAt: string;
}

/**
 * Proof that funding came from a controlled source
 *
 * This ZK proof can be used to prove:
 * "I control the wallet that originally funded this ephemeral wallet"
 * WITHOUT revealing which wallet.
 */
export interface FundingLinkProof {
  /** The ephemeral wallet address being proven */
  ephemeralAddress: string;
  /** ZK proof data (Groth16) */
  proof: Uint8Array;
  /** Public inputs to the proof */
  publicInputs: {
    /** Commitment to the main wallet public key */
    mainWalletCommitment: Uint8Array;
    /** The ephemeral wallet address (public) */
    ephemeralAddress: string;
    /** Timestamp of the proof */
    timestamp: string;
  };
}

/**
 * Full disclosure proof for legal/audit
 *
 * When full transparency is required (court order, audit),
 * this reveals the complete funding path.
 */
export interface FundingDisclosure {
  /** Main wallet that originated the funds */
  mainWalletAddress: string;
  /** Shield transaction hash */
  shieldTxHash: string;
  /** Unshield transaction hash */
  unshieldTxHash: string;
  /** Ephemeral wallet address */
  ephemeralWalletAddress: string;
  /** Signature proving control of main wallet */
  mainWalletSignature: Uint8Array;
  /** Message that was signed */
  signedMessage: string;
}

/**
 * Service interface for Midnight shielded funding operations
 *
 * NOTE: This is the interface specification. Implementation requires
 * integration with Midnight SDK (@midnight-ntwrk packages).
 */
export interface ShieldedFundingService {
  /**
   * Shield funds from main wallet into Midnight pool
   *
   * This breaks the on-chain link. After shielding, the funds
   * cannot be traced back to the main wallet.
   *
   * @param mainWalletPrivateKey - Private key of main wallet
   * @param amount - Amount to shield (in lovelace)
   * @returns Shielded balance with private witness
   */
  shieldFunds(
    mainWalletPrivateKey: Uint8Array,
    amount: bigint
  ): Promise<ShieldedBalance>;

  /**
   * Create ephemeral wallet funded from shielded pool
   *
   * @param shieldedBalance - Balance to unshield from
   * @param amount - Amount to fund ephemeral wallet
   * @returns Fresh ephemeral wallet with funds
   */
  createEphemeralWallet(
    shieldedBalance: ShieldedBalance,
    amount: bigint
  ): Promise<EphemeralWallet>;

  /**
   * Generate ZK proof that ephemeral wallet was funded by controlled source
   *
   * Use this when you need to prove ownership without revealing identity.
   *
   * @param mainWalletPrivateKey - To prove control
   * @param ephemeralWallet - The wallet to prove funding for
   * @param shieldedWitness - Private witness from shield transaction
   */
  generateFundingProof(
    mainWalletPrivateKey: Uint8Array,
    ephemeralWallet: EphemeralWallet,
    shieldedWitness: ShieldedWitness
  ): Promise<FundingLinkProof>;

  /**
   * Generate full disclosure for legal/audit
   *
   * Use this when complete transparency is required.
   *
   * @param mainWalletPrivateKey - To sign the disclosure
   * @param shieldTxHash - The shield transaction
   * @param unshieldTxHash - The unshield transaction
   * @param ephemeralWallet - The funded wallet
   */
  generateFullDisclosure(
    mainWalletPrivateKey: Uint8Array,
    shieldTxHash: string,
    unshieldTxHash: string,
    ephemeralWallet: EphemeralWallet
  ): Promise<FundingDisclosure>;

  /**
   * Verify a funding link proof
   *
   * @param proof - The ZK proof to verify
   * @returns true if proof is valid
   */
  verifyFundingProof(proof: FundingLinkProof): Promise<boolean>;

  /**
   * Verify a full disclosure
   *
   * @param disclosure - The disclosure to verify
   * @returns true if disclosure is valid and signature matches
   */
  verifyFullDisclosure(disclosure: FundingDisclosure): Promise<boolean>;
}

/**
 * Configuration for shielded funding service
 */
export interface ShieldedFundingConfig {
  /** Midnight network endpoint */
  midnightEndpoint: string;
  /** Cardano network (mainnet/testnet) */
  cardanoNetwork: "mainnet" | "preprod" | "preview";
  /** Minimum shield amount (to prevent dust attacks) */
  minShieldAmount: bigint;
  /** Default expiry for ephemeral wallets (ms) */
  defaultWalletExpiry: number;
}
