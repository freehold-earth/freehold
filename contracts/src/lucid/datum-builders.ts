/**
 * Datum and Redeemer Builders for S-PAL Contract
 *
 * Builds Plutus Data structures matching the Aiken blueprint (plutus.json).
 * Uses Lucid Evolution's Data API for serialization.
 */

import { Data, Constr } from "@lucid-evolution/lucid";
import type { SPALPolicy, IdentityLinkage, ValidationRequest, PaymentCurrency } from "../types.js";
import { validatePaymentCurrency } from "../types.js";

/**
 * Text encoder for converting strings to ByteArray
 */
const encoder = new TextEncoder();

/**
 * Convert string to hex-encoded ByteArray
 */
function stringToHex(str: string): string {
  return Array.from(encoder.encode(str))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build IdentityLinkage as Plutus Data
 *
 * Matches Aiken type:
 * ```aiken
 * pub type IdentityLinkage {
 *   ephemeral_required: Bool,
 *   proof_of_root_allowed: Bool,
 *   zk_continuity_allowed: Bool,
 * }
 * ```
 */
export function buildIdentityLinkage(linkage: IdentityLinkage): Constr<Data> {
  // Bool in Plutus: False = Constr(0, []), True = Constr(1, [])
  const boolToData = (b: boolean): Constr<Data> => new Constr(b ? 1 : 0, []);

  return new Constr(0, [
    boolToData(linkage.ephemeralRequired),
    boolToData(linkage.proofOfRootAllowed),
    boolToData(linkage.zkContinuityAllowed),
  ]);
}

/**
 * Build PaymentCurrency as Plutus Data
 *
 * Matches Aiken type:
 * ```aiken
 * pub type PaymentCurrency {
 *   Ada                                                    // Constr(0, [])
 *   NativeToken { policy_id: ByteArray, asset_name: ByteArray } // Constr(1, [policy_id, asset_name])
 * }
 * ```
 *
 * Validates NativeToken fields before serialization to prevent invalid on-chain data.
 */
export function buildPaymentCurrency(currency: PaymentCurrency): Constr<Data> {
  validatePaymentCurrency(currency);

  if (currency.kind === "Ada") {
    return new Constr(0, []);
  }
  return new Constr(1, [currency.policyId, currency.assetName]);
}

/**
 * Build PolicyDatum as Plutus Data
 *
 * Matches Aiken type:
 * ```aiken
 * pub type PolicyDatum {
 *   owner: ByteArray,
 *   min_payment: Int,
 *   max_retention_ms: Int,
 *   identity_linkage: IdentityLinkage,
 *   required_proof_hash: ByteArray,
 *   context_scope: ByteArray,
 *   payment_currency: PaymentCurrency,
 * }
 * ```
 */
export function buildPolicyDatum(policy: SPALPolicy): Constr<Data> {
  return new Constr(0, [
    policy.ownerPkh, // ByteArray (hex string)
    policy.minPayment, // Int (bigint)
    BigInt(policy.maxRetentionMs), // Int (bigint)
    buildIdentityLinkage(policy.identityLinkage), // IdentityLinkage
    policy.requiredProofHash || "", // ByteArray (hex string, empty if no proof required)
    stringToHex(policy.contextScope), // ByteArray (hex-encoded string)
    buildPaymentCurrency(policy.paymentCurrency), // PaymentCurrency
  ]);
}

/**
 * Build AccessRedeemer as Plutus Data
 *
 * Matches Aiken type:
 * ```aiken
 * pub type AccessRedeemer {
 *   requester_did: ByteArray,
 *   proof_reference: ByteArray,
 *   access_time: Int,
 *   payment_amount: Int,
 * }
 * ```
 */
export function buildAccessRedeemer(request: ValidationRequest): Constr<Data> {
  // Convert proof reference to hex if it's not already hex
  // (empty string stays empty, otherwise convert)
  const proofHex = request.proofReference
    ? isHex(request.proofReference)
      ? request.proofReference
      : stringToHex(request.proofReference)
    : "";

  return new Constr(0, [
    stringToHex(request.requesterDid), // ByteArray (hex-encoded DID)
    proofHex, // ByteArray (hex string, empty if no proof)
    BigInt(request.accessTime), // Int (bigint)
    request.paymentAmount, // Int (bigint)
  ]);
}

/**
 * Check if a string is valid hex (even length, only hex chars)
 */
function isHex(str: string): boolean {
  return str.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(str);
}

/**
 * Parse IdentityLinkage from Plutus Data
 */
export function parseIdentityLinkage(data: Data): IdentityLinkage {
  if (!(data instanceof Constr)) {
    throw new Error("Invalid IdentityLinkage data: expected Constr");
  }

  const fields = data.fields;
  if (fields.length !== 3) {
    throw new Error(`Invalid IdentityLinkage data: expected 3 fields, got ${fields.length}`);
  }

  // Bool in Plutus: Constr(0) = False, Constr(1) = True
  const dataToBool = (d: Data): boolean => {
    if (!(d instanceof Constr)) {
      throw new Error("Invalid Bool data: expected Constr");
    }
    return d.index === 1;
  };

  return {
    ephemeralRequired: dataToBool(fields[0]),
    proofOfRootAllowed: dataToBool(fields[1]),
    zkContinuityAllowed: dataToBool(fields[2]),
  };
}

/**
 * Convert hex-encoded ByteArray to string
 */
function hexToString(hex: string): string {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
  return new TextDecoder().decode(bytes);
}

/**
 * Parse PaymentCurrency from Plutus Data
 */
export function parsePaymentCurrency(data: Data): PaymentCurrency {
  if (!(data instanceof Constr)) {
    throw new Error("Invalid PaymentCurrency data: expected Constr");
  }

  if (data.index === 0) {
    return { kind: "Ada" };
  }

  if (data.index === 1) {
    if (data.fields.length !== 2) {
      throw new Error(
        `Invalid NativeToken data: expected 2 fields, got ${data.fields.length}`
      );
    }
    const parsed = {
      kind: "NativeToken" as const,
      policyId: data.fields[0] as string,
      assetName: data.fields[1] as string,
    };
    validatePaymentCurrency(parsed);
    return parsed;
  }

  throw new Error(`Invalid PaymentCurrency constructor index: ${data.index}`);
}

/**
 * Parse PolicyDatum from Plutus Data
 */
export function parsePolicyDatum(data: Data): SPALPolicy {
  if (!(data instanceof Constr)) {
    throw new Error("Invalid PolicyDatum data: expected Constr");
  }

  const fields = data.fields;
  if (fields.length !== 7) {
    throw new Error(`Invalid PolicyDatum data: expected 7 fields, got ${fields.length}`);
  }

  return {
    id: "", // Policy ID not stored in datum, must be tracked separately
    ownerPkh: fields[0] as string,
    minPayment: fields[1] as bigint,
    maxRetentionMs: Number(fields[2] as bigint),
    identityLinkage: parseIdentityLinkage(fields[3]),
    requiredProofHash: fields[4] as string,
    contextScope: hexToString(fields[5] as string),
    paymentCurrency: parsePaymentCurrency(fields[6]),
  };
}

/**
 * Serialize datum to CBOR hex for inline datum
 */
export function serializeDatum(policy: SPALPolicy): string {
  const datum = buildPolicyDatum(policy);
  return Data.to(datum);
}

/**
 * Serialize redeemer to CBOR hex
 */
export function serializeRedeemer(request: ValidationRequest): string {
  const redeemer = buildAccessRedeemer(request);
  return Data.to(redeemer);
}

/**
 * Deserialize datum from CBOR hex
 */
export function deserializeDatum(cbor: string): SPALPolicy {
  const data = Data.from(cbor);
  return parsePolicyDatum(data);
}
