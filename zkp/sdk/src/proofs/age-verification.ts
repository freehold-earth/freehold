/**
 * Age Verification - Prove age without revealing birth date
 *
 * Uses Midnight's Compact contract when network is available,
 * falls back to placeholder proofs for offline/testing scenarios.
 *
 * Privacy model: Each proof interaction deploys a FRESH ephemeral contract.
 * This prevents cross-verifier correlation — Company A and Company B cannot
 * link proofs to the same user.
 */

import { createHash } from "node:crypto";
import type { Proof, ProofConfig, AgeProofInput } from "../types.js";
import { isOnChainProof } from "../types.js";
import {
  getClientState,
  initializeClient,
  queryContractState,
  queryTransaction,
  type MidnightConfig,
  buildIndexerUrls,
} from "../midnight/client.js";
import {
  getOrCreateWallet,
  resolveContractAssetsPath,
  deployAndVerifyAge,
  REQUESTER_COMMITMENT_LENGTH,
  type WalletConfig,
} from "../midnight/index.js";

/**
 * The commitment the circuit discloses for the DID a proof names: SHA-256 of
 * the DID text's UTF-8 bytes, or all zeros when the proof names nobody. A verifier
 * recomputes it from `publicSignals.requesterDid` and compares it with what
 * the circuit wrote, so the DID cannot be swapped after the fact.
 */
export function requesterCommitment(requesterDid?: string): Uint8Array {
  if (requesterDid === undefined) {
    return new Uint8Array(REQUESTER_COMMITMENT_LENGTH);
  }
  return new Uint8Array(createHash("sha256").update(requesterDid, "utf8").digest());
}

/**
 * A 32-byte value as a proof's signals or the ledger may carry it: hex (with
 * or without 0x), a byte array, or a JSON array of numbers. Null for anything
 * else, which a verifier treats as "not what the circuit wrote".
 *
 * The ledger's Bytes<32> arrives as a Uint8Array from the compiled contract's
 * decoder (pinned by the live requester-commitment test); the signals carry
 * the lowercase hex this SDK writes.
 */
function commitmentBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value.length === REQUESTER_COMMITMENT_LENGTH ? value : null;
  }
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return value.length === REQUESTER_COMMITMENT_LENGTH ? Uint8Array.from(value) : null;
  }
  if (typeof value === "string") {
    const hexText = value.startsWith("0x") ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]{64}$/.test(hexText)) {
      return null;
    }
    if (hexText !== value || hexText !== hexText.toLowerCase()) {
      // Accepted, but not how this SDK writes it; worth seeing in the integration test.
      console.warn("requester commitment read in a non-canonical spelling");
    }
    return new Uint8Array(Buffer.from(hexText, "hex"));
  }
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export class AgeVerification {
  private initialized = false;
  private useMidnight = false;

  constructor(private readonly config: ProofConfig & MidnightConfig) {}

  /**
   * Calculate age from birth date and current date.
   */
  private calculateAge(birthDate: Date, currentDate: Date): number {
    let age = currentDate.getFullYear() - birthDate.getFullYear();
    const birthdayPassed =
      currentDate.getMonth() > birthDate.getMonth() ||
      (currentDate.getMonth() === birthDate.getMonth() &&
        currentDate.getDate() >= birthDate.getDate());
    if (!birthdayPassed) {
      age--;
    }
    return age;
  }

  /**
   * Initialize the verifier, connecting to Midnight if available
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return this.useMidnight;
    }

    this.useMidnight = await initializeClient(this.config);
    this.initialized = true;

    return this.useMidnight;
  }

  /**
   * Generate an age verification proof
   *
   * Proves: age >= minAge
   * Reveals: minAge threshold, whether verified, requesterDid (if provided)
   * Hides: exact birth date
   *
   * Accepts either typed input or raw API input with birthDate as string
   */
  async generate(input: AgeProofInput | { birthDate?: string; minAge?: number; requesterDid?: string }): Promise<Proof> {
    // Parse input - handle both Date objects and ISO strings
    const birthDate = input.birthDate instanceof Date
      ? input.birthDate
      : input.birthDate
        ? (() => {
            // Parse date-only strings (YYYY-MM-DD) as local dates to avoid
            // timezone shift: new Date("YYYY-MM-DD") parses as UTC midnight,
            // which rolls back a day in negative UTC offsets (e.g. EST).
            const parts = input.birthDate!.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (parts) {
              return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
            }
            return new Date(input.birthDate!);
          })()
        : null;

    if (!birthDate || isNaN(birthDate.getTime())) {
      return {
        verificationMethod: "offline",
        proof: "",
        publicSignals: { verified: false, error: "Invalid or missing birth date" },
        verificationKey: "",
        circuitId: "age_verification",
        timestamp: new Date(),
      };
    }

    const minAge = input.minAge ?? 18;
    if (!Number.isInteger(minAge) || minAge < 0) {
      throw new RangeError("minAge must be a non-negative integer");
    }
    // An empty name is no name: it must not be hashed into the commitment
    // while being left out of the signals.
    const requesterDid = input.requesterDid || undefined;
    // Use provided currentDate or default to now
    const currentDate = ('currentDate' in input && input.currentDate instanceof Date)
      ? input.currentDate
      : new Date();

    // Ensure initialized
    await this.initialize();

    // Try to use Midnight network if available
    const clientState = getClientState();
    if (clientState.connected && clientState.providers) {
      return this.generateWithMidnight(birthDate, minAge, currentDate, requesterDid);
    }

    // On mainnet, never fall back to placeholder proofs — this is a security gap.
    // Placeholder proofs are only acceptable for development/testing networks.
    if (this.config.network === "mainnet") {
      throw new Error(
        "Midnight network unavailable. Placeholder proofs are disabled on mainnet for security."
      );
    }

    // Fall back to placeholder proof (non-mainnet only)
    return this.generatePlaceholder(birthDate, minAge, currentDate, requesterDid);
  }

  /**
   * Generate proof using real Midnight network.
   *
   * 1. Creates/reuses an HD wallet singleton
   * 2. Waits for wallet sync
   * 3. Deploys a fresh ephemeral contract (privacy: no cross-verifier linkability)
   * 4. Calls verifyAge circuit — auto-generates ZK proof, submits tx
   * 5. Returns OnChainProof with real on-chain metadata
   */
  private async generateWithMidnight(
    birthDate: Date,
    minAge: number,
    currentDate: Date,
    requesterDid?: string
  ): Promise<Proof> {
    const walletConfig = this.buildWalletConfig();
    const wallet = await getOrCreateWallet(walletConfig);
    await wallet.waitForSync(30_000);

    const assetsPath = resolveContractAssetsPath(this.config.contractAssetsPath);

    const commitment = requesterCommitment(requesterDid);
    const result = await deployAndVerifyAge(
      wallet,
      walletConfig,
      birthDate,
      minAge,
      currentDate,
      assetsPath,
      commitment,
    );

    // The verified flag is read back from on-chain contract state. The
    // requester commitment published here is the value this call gave the
    // circuit; verify() reads the one the circuit wrote to the ledger and
    // refuses the proof if the DID named here does not hash to it.
    // network is caller-supplied metadata; minAge is checked against the
    // ledger's lastMinAge by verify().
    const publicSignals: Record<string, unknown> = {
      verified: result.verified,
      minAge,
      network: this.config.network ?? "standalone",
      requesterCommitment: Buffer.from(commitment).toString("hex"),
    };

    if (requesterDid) {
      publicSignals.requesterDid = requesterDid;
    }

    return {
      verificationMethod: "on-chain",
      proof: result.txId,
      publicSignals,
      verificationKey: "age_verification_vk_midnight",
      circuitId: "age_verification",
      timestamp: new Date(),
      txId: result.txId,
      contractAddress: result.contractAddress,
      blockHeight: result.blockHeight,
      dustFee: result.dustFee.toString(),
    };
  }

  /**
   * The wallet configuration this handler's proofs use, so a service can
   * create the wallet ahead of the first proof.
   */
  walletConfig(): WalletConfig {
    return this.buildWalletConfig();
  }

  /**
   * Build a WalletConfig from the current MidnightConfig.
   */
  private buildWalletConfig(): WalletConfig {
    const { httpUrl, wsUrl } = buildIndexerUrls(this.config.indexerUrl ?? "http://localhost:8088");

    return {
      seed: this.config.walletSeed,
      network: this.config.network ?? "standalone",
      indexerUrl: httpUrl,
      indexerWsUrl: wsUrl,
      nodeUrl: this.config.nodeUrl ?? "ws://localhost:9944",
      proofServerUrl: this.config.proofServerUrl ?? "http://localhost:6300",
    };
  }

  /**
   * Generate placeholder proof (when Midnight not available)
   */
  private generatePlaceholder(
    birthDate: Date,
    minAge: number,
    currentDate: Date,
    requesterDid?: string
  ): Proof {
    const verified = this.calculateAge(birthDate, currentDate) >= minAge;
    const commitment = Buffer.from(requesterCommitment(requesterDid)).toString("hex");

    // The same shape as an on-chain proof: the DID named in the public
    // signals and a commitment to it that the proof data carries in place of
    // the ledger, so a placeholder relabelled with another DID fails the
    // same check.
    const publicSignals: Record<string, unknown> = {
      verified,
      minAge,
      network: "mocked",
      requesterCommitment: commitment,
    };

    if (requesterDid) {
      publicSignals.requesterDid = requesterDid;
    }

    return {
      verificationMethod: "offline",
      proof: this.generatePlaceholderProofData(commitment),
      publicSignals,
      verificationKey: "age_verification_vk_placeholder",
      circuitId: "age_verification",
      timestamp: new Date(),
    };
  }

  /**
   * Whether a proof shows its holder met the age threshold it names.
   *
   * True only for a proof that is authentic and whose verified flag is set:
   * a genuine proof that the holder was under age does not pass. The
   * threshold must be a non-negative integer, the public signals must carry
   * the commitment of the DID they name, and with `expectedDid` the proof
   * must name exactly that DID.
   *
   * For Midnight proofs with on-chain metadata (txId + contractAddress), the
   * ledger and the transaction are checked against the chain (see
   * verifyMidnightProof). Without on-chain metadata: in Midnight mode the
   * proof is rejected; otherwise a placeholder is accepted off mainnet only,
   * and only for the DID it was generated for.
   */
  async verify(proof: Proof, expectedDid?: string): Promise<boolean> {
    if (proof.circuitId !== "age_verification") {
      throw new Error("Invalid circuit ID for age verification");
    }

    // Ensure we know whether the Midnight network is available.
    await this.initialize();

    const signals = proof.publicSignals as {
      verified?: boolean;
      minAge?: number;
      requesterDid?: unknown;
      requesterCommitment?: unknown;
      network?: string;
    };

    // The threshold is a non-negative integer or the circuit was never asked
    // for it; and a proof that the holder did not meet it, however genuine,
    // does not pass: verify() answers whether the holder met the threshold.
    const structureValid =
      signals.verified === true &&
      typeof signals.minAge === "number" &&
      Number.isInteger(signals.minAge) &&
      signals.minAge >= 0;

    if (!structureValid) {
      return false;
    }

    // If a DID is expected, the proof must name exactly it; an empty
    // expectation is a name no proof can carry.
    if (expectedDid !== undefined && signals.requesterDid !== expectedDid) {
      return false;
    }
    // Named or not: an empty name is neither, and is refused.
    if (signals.requesterDid !== undefined && (typeof signals.requesterDid !== "string" || signals.requesterDid === "")) {
      return false;
    }
    // The public signals carry the commitment too, for readers that never see
    // the ledger or the proof data; it must be the commitment of the DID named
    // beside it, or the signals have been edited.
    const published = commitmentBytes(signals.requesterCommitment);
    if (published === null || !sameBytes(published, requesterCommitment(signals.requesterDid))) {
      return false;
    }

    // When Midnight is active, verify on-chain
    if (this.useMidnight) {
      return this.verifyMidnightProof(proof, signals.requesterDid);
    }

    // On mainnet, reject placeholder proofs in the verify path too —
    // they should never be accepted in a production environment.
    if (this.config.network === "mainnet") {
      return false;
    }

    // Placeholder proofs are trusted only in offline/test mode, and even
    // then only for the DID they were generated for.
    return this.placeholderCommitsTo(proof, signals.requesterDid);
  }

  /**
   * Whether a placeholder proof's data carries the commitment for the DID
   * its public signals name. The proof data is base64 JSON written by
   * generatePlaceholder; anything else is not a placeholder of ours.
   */
  private placeholderCommitsTo(proof: Proof, requesterDid?: string): boolean {
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(proof.proof, "base64").toString("utf8"));
    } catch {
      return false;
    }
    if (!data || typeof data !== "object" || !("requesterCommitment" in data)) {
      return false;
    }
    const committed = commitmentBytes(data.requesterCommitment);
    return committed !== null && sameBytes(committed, requesterCommitment(requesterDid));
  }

  /**
   * Verify a Midnight-generated proof via on-chain data
   *
   * Verification strategy (Midnight has no off-chain verification API):
   * 1. Require on-chain proof (verificationMethod === "on-chain")
   * 2. Read the contract's ledger from the indexer, decoded by the compiled
   *    contract: `verified` must match the claim, `lastMinAge` the claimed
   *    threshold, and the requester commitment the DID the proof names
   * 3. Confirm the transaction exists at the claimed block height and acted
   *    on the proof's contract
   *
   * SECURITY NOTE: each contract is ephemeral (deployed per proof) and the
   * circuit refuses a second call, so the ledger read here is what the
   * proof's own transaction wrote, and the transaction is bound to the
   * contract through the contract actions the indexer records for it. What
   * is not yet checked is that the contract at the proof's address is the
   * compiled age contract rather than another contract with the same ledger
   * layout; that check (verifier keys or contract code against the compiled
   * circuit) is tracked in #111.
   *
   * Offline proofs are rejected — they lack the on-chain record needed for
   * cryptographic verification.
   */
  private async verifyMidnightProof(proof: Proof, requesterDid?: string): Promise<boolean> {
    // Require on-chain metadata for verification
    if (!isOnChainProof(proof)) {
      // Offline proof — cannot verify via on-chain data.
      return false;
    }

    const clientState = getClientState();
    if (!clientState.config?.indexerUrl) {
      // Midnight is active but config is missing — cannot verify.
      return false;
    }
    const indexerUrl = clientState.config.indexerUrl;

    // 1. Read the circuit's ledger for the proof's contract from the indexer
    const contractState = await queryContractState(
      indexerUrl,
      proof.contractAddress,
      this.config.contractAssetsPath,
    );
    if (!contractState) {
      return false;
    }

    // 2. Check the on-chain verified field matches the proof's claim.
    if (contractState.verified === undefined) {
      // Contract state does not contain a 'verified' field — schema mismatch.
      return false;
    }
    if (contractState.verified !== proof.publicSignals.verified) {
      return false;
    }

    // 2a. The threshold the circuit was asked for is on the ledger too; the
    // proof's claim of it is checked against the chain, not taken as said.
    const minAge = proof.publicSignals.minAge;
    if (typeof minAge !== "number" || !Number.isInteger(minAge) || contractState.lastMinAge !== BigInt(minAge)) {
      return false;
    }

    // 2b. The circuit wrote a commitment to the DID the proof is for; the DID
    // the proof names must hash to it (and a proof naming nobody must have
    // the zero commitment), or the proof has been relabelled.
    const committed = commitmentBytes(contractState.requesterCommitment);
    if (committed === null || !sameBytes(committed, requesterCommitment(requesterDid))) {
      return false;
    }

    // 3. Confirm the transaction exists on-chain and acted on this contract,
    // so a real transaction cannot vouch for a contract it never touched
    // (see SECURITY NOTE above).
    const txResult = await queryTransaction(indexerUrl, proof.txId);
    const contractAddress = proof.contractAddress.toLowerCase();
    if (!txResult || !txResult.contractAddresses.some((address) => address.toLowerCase() === contractAddress)) {
      return false;
    }

    // 4. Verify block height matches.
    if (txResult.blockHeight !== proof.blockHeight) {
      return false;
    }

    return true;
  }

  private generatePlaceholderProofData(requesterCommitment: string): string {
    return Buffer.from(
      JSON.stringify({
        type: "age_verification",
        version: "1.0",
        placeholder: true,
        requesterCommitment,
      })
    ).toString("base64");
  }

}
