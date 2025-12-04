/**
 * Helios contract compilation utilities
 */

import type { CompiledScript } from "./types.js";

// Helios contract source (embedded)
const SPAL_ENFORCER_SOURCE = `
spending spal_enforcer

// S-PAL Policy datum structure
struct Policy {
    owner: PubKeyHash
    max_retention: Int
    derivatives_forbidden: Bool
    required_payment: Int
}

// Redeemer for validation requests
struct ValidationRedeemer {
    requester_did_hash: ByteArray
    context_scope_hash: ByteArray
    proof_hash: ByteArray
    retention_timestamp: Int
}

func main(policy: Policy, redeemer: ValidationRedeemer, ctx: ScriptContext) -> Bool {
    tx: Tx = ctx.tx;

    // 1. Verify owner signature
    owner_signed: Bool = tx.is_signed_by(policy.owner);

    // 2. Verify retention is within limits
    // (in production, this would check actual timestamps)
    retention_valid: Bool = redeemer.retention_timestamp <= policy.max_retention;

    // 3. Verify payment if required
    payment_valid: Bool = if (policy.required_payment > 0) {
        // Check that payment was made to owner
        tx.value_sent_to(policy.owner).get_lovelace() >= policy.required_payment
    } else {
        true
    };

    // All conditions must pass
    owner_signed && retention_valid && payment_valid
}
`;

let cachedScript: CompiledScript | null = null;

/**
 * Compile the S-PAL enforcer contract
 */
export async function compileValidator(): Promise<CompiledScript> {
  if (cachedScript) {
    return cachedScript;
  }

  try {
    // Dynamic import of Helios
    const { Program } = await import("@helios-lang/compiler");

    const program = new Program(SPAL_ENFORCER_SOURCE);
    const uplc = program.compile();

    // The @helios-lang/compiler API returns UPLC which has toCbor() and hash()
    const cbor = uplc.toCbor();
    const scriptHash = uplc.hash();

    cachedScript = {
      cborHex: typeof cbor === "string" ? cbor : Buffer.from(cbor).toString("hex"),
      hash: typeof scriptHash === "string" ? scriptHash : scriptHash.toString(),
    };

    return cachedScript;
  } catch (error) {
    throw new Error(`Failed to compile contract: ${error}`);
  }
}

/**
 * Get the compiled script (compile if needed)
 */
export async function getCompiledScript(): Promise<CompiledScript> {
  return compileValidator();
}

/**
 * Get the raw Helios source
 */
export function getHeliosSource(): string {
  return SPAL_ENFORCER_SOURCE;
}
