/**
 * S-PAL Enforcer - Smart contract wrapper for policy enforcement
 *
 * Provides both off-chain validation and on-chain transaction building
 * using Lucid Evolution SDK with the Aiken-compiled S-PAL validator.
 */

import {
  SpendingValidator,
  Address,
  Data,
  validatorToAddress,
  credentialToAddress,
  keyHashToCredential,
  type LucidEvolution,
  type UTxO,
  type Network,
} from "@lucid-evolution/lucid";
import type {
  CompiledScript,
  SPALPolicy,
  ValidationRequest,
  ValidationResult,
  LucidConfig,
  PolicyUtxo,
} from "../types.js";
import { compileValidator } from "../compile.js";
import { initializeLucid } from "../lucid/provider.js";
import {
  buildPolicyDatum,
  buildAccessRedeemer,
  parsePolicyDatum,
} from "../lucid/datum-builders.js";

// Load the Aiken blueprint for script reference
import blueprint from "../../spal_validator/plutus.json" with { type: "json" };

/**
 * Minimum lovelace for UTxO (protocol minimum)
 */
const MIN_UTXO_LOVELACE = 2_000_000n;

export class SPALEnforcer {
  private script: CompiledScript;
  private lucid: LucidEvolution | null = null;
  private validator: SpendingValidator | null = null;
  private scriptAddress: Address | null = null;
  private network: Network = "Preview";

  constructor(script: CompiledScript) {
    this.script = script;
  }

  /**
   * Create an enforcer with a freshly compiled script
   */
  static async create(): Promise<SPALEnforcer> {
    const script = await compileValidator();
    return new SPALEnforcer(script);
  }

  /**
   * Create an enforcer using the Aiken blueprint
   */
  static fromBlueprint(): SPALEnforcer {
    // Get the spend validator from the blueprint
    const spendValidator = blueprint.validators.find(
      (v) => v.title === "spal.spal.spend"
    );

    if (!spendValidator) {
      throw new Error("S-PAL spend validator not found in blueprint");
    }

    const script: CompiledScript = {
      cborHex: spendValidator.compiledCode,
      hash: spendValidator.hash,
    };

    return new SPALEnforcer(script);
  }

  /**
   * Initialize Lucid for on-chain operations
   */
  async initLucid(config: LucidConfig): Promise<void> {
    this.lucid = await initializeLucid(config);

    // Store network for utility functions
    this.network = config.network === "Custom" ? "Custom" : config.network;

    // Create spending validator from CBOR
    this.validator = {
      type: "PlutusV3",
      script: this.script.cborHex,
    } as SpendingValidator;

    // Derive script address using standalone utility
    this.scriptAddress = validatorToAddress(this.network, this.validator);
  }

  /**
   * Get the script hash (for reference in transactions)
   */
  getScriptHash(): string {
    return this.script.hash;
  }

  /**
   * Get the compiled CBOR hex
   */
  getCborHex(): string {
    return this.script.cborHex;
  }

  /**
   * Get the script address (requires initLucid first)
   */
  getScriptAddress(): Address {
    if (!this.scriptAddress) {
      throw new Error("Lucid not initialized. Call initLucid first.");
    }
    return this.scriptAddress;
  }

  /**
   * Validate a request against a policy (off-chain simulation)
   *
   * This performs validation logic that mirrors the on-chain contract
   * for fast off-chain checking before submitting transactions.
   */
  async validate(
    policy: SPALPolicy,
    request: ValidationRequest
  ): Promise<ValidationResult> {
    // 1. Check identity linkage requirements
    if (policy.identityLinkage.ephemeralRequired) {
      // Ephemeral DIDs must be did:key format
      if (!request.requesterDid.startsWith("did:key:z")) {
        return {
          valid: false,
          error: "Ephemeral DID (did:key) required for this policy",
        };
      }
    }

    // 2. Check payment if required
    if (policy.minPayment > 0n) {
      if (request.paymentAmount < policy.minPayment) {
        return {
          valid: false,
          error: `Insufficient payment: required ${policy.minPayment}, got ${request.paymentAmount}`,
        };
      }
    }

    // 3. Check proof requirement
    if (policy.requiredProofHash && policy.requiredProofHash.length > 0) {
      if (!request.proofReference || request.proofReference.length === 0) {
        return {
          valid: false,
          error: "Proof reference required but not provided",
        };
      }
    }

    return { valid: true };
  }

  /**
   * Create a policy UTxO on-chain
   *
   * @param policy - The S-PAL policy to deploy
   * @returns Transaction hash
   */
  async createPolicyUtxo(policy: SPALPolicy): Promise<string> {
    if (!this.lucid || !this.scriptAddress) {
      throw new Error("Lucid not initialized. Call initLucid first.");
    }

    const datum = buildPolicyDatum(policy);
    const datumCbor = Data.to(datum);

    const tx = await this.lucid
      .newTx()
      .pay.ToAddressWithData(
        this.scriptAddress,
        { kind: "inline", value: datumCbor },
        { lovelace: MIN_UTXO_LOVELACE }
      )
      .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();

    return txHash;
  }

  /**
   * Find policy UTxOs at the script address
   */
  async findPolicyUtxos(): Promise<PolicyUtxo[]> {
    if (!this.lucid || !this.scriptAddress) {
      throw new Error("Lucid not initialized. Call initLucid first.");
    }

    const utxos = await this.lucid.utxosAt(this.scriptAddress);
    const result: PolicyUtxo[] = [];

    for (const utxo of utxos) {
      if (utxo.datum) {
        try {
          const data = Data.from(utxo.datum);
          const policy = parsePolicyDatum(data);
          result.push({
            txHash: utxo.txHash,
            outputIndex: utxo.outputIndex,
            datum: policy,
            lovelace: utxo.assets.lovelace,
          });
        } catch {
          // Skip UTxOs with invalid datums
          continue;
        }
      }
    }

    return result;
  }

  /**
   * Build a transaction for on-chain validation
   *
   * @param policy - The S-PAL policy to validate against
   * @param policyUtxo - The UTxO containing the policy datum
   * @param request - The validation request
   * @returns Unsigned transaction CBOR hex
   */
  async buildValidationTx(
    policy: SPALPolicy,
    policyUtxo: PolicyUtxo,
    request: ValidationRequest
  ): Promise<{ txCbor: string }> {
    if (!this.lucid || !this.validator || !this.scriptAddress) {
      throw new Error("Lucid not initialized. Call initLucid first.");
    }

    // Build redeemer
    const redeemer = buildAccessRedeemer(request);
    const redeemerCbor = Data.to(redeemer);

    // Rebuild datum for return output
    const datum = buildPolicyDatum(policy);
    const datumCbor = Data.to(datum);

    // Find the UTxO
    const utxos = await this.lucid.utxosAt(this.scriptAddress);
    const targetUtxo = utxos.find(
      (u: UTxO) => u.txHash === policyUtxo.txHash && u.outputIndex === policyUtxo.outputIndex
    );

    if (!targetUtxo) {
      throw new Error("Policy UTxO not found");
    }

    // Build transaction
    let txBuilder = this.lucid
      .newTx()
      .collectFrom([targetUtxo], redeemerCbor)
      .attach.SpendingValidator(this.validator)
      .addSignerKey(policy.ownerPkh);

    // Add payment output if required
    if (policy.minPayment > 0n && request.paymentAmount > 0n) {
      // Payment goes to owner - use standalone utility
      const paymentCredential = keyHashToCredential(policy.ownerPkh);
      const ownerAddress = credentialToAddress(this.network, paymentCredential);
      txBuilder = txBuilder.pay.ToAddress(ownerAddress, {
        lovelace: request.paymentAmount,
      });
    }

    // Return datum to script address
    txBuilder = txBuilder.pay.ToAddressWithData(
      this.scriptAddress,
      { kind: "inline", value: datumCbor },
      { lovelace: MIN_UTXO_LOVELACE }
    );

    const tx = await txBuilder.complete();

    return { txCbor: tx.toString() };
  }

  /**
   * Sign and submit a validation transaction
   *
   * Takes an unsigned transaction CBOR, signs it with the configured wallet,
   * and submits it to the network.
   *
   * @param unsignedTxCbor - Unsigned transaction CBOR hex from buildValidationTx
   * @returns Transaction hash
   */
  async signAndSubmitValidationTx(unsignedTxCbor: string): Promise<string> {
    if (!this.lucid) {
      throw new Error("Lucid not initialized. Call initLucid first.");
    }

    // fromTx returns TxSignBuilder for unsigned transactions
    const txSignBuilder = this.lucid.fromTx(unsignedTxCbor);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    const txHash = await signedTx.submit();

    return txHash;
  }
}
