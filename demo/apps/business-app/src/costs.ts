/**
 * What a proof cost, read from the proof the agent stored. An on-chain proof
 * reports the DUST its transactions cost, in specks, as a decimal string
 * (`dustFee`); the proof service's wallet paid it from capacity a sponsor
 * designated to it, so the customer paid nothing. An offline proof made no
 * transaction and cost nothing.
 */
export type ProofCost =
  | { kind: "on-chain"; specks: bigint }
  | { kind: "offline" }
  | { kind: "unreported" };

export function proofCost(proof: Record<string, unknown> | null | undefined): ProofCost {
  if (!proof) return { kind: "unreported" };
  if (proof.verificationMethod === "offline") return { kind: "offline" };
  const fee = proof.dustFee;
  if (typeof fee === "string" && /^[0-9]+$/.test(fee)) {
    return { kind: "on-chain", specks: BigInt(fee) };
  }
  return { kind: "unreported" };
}

/** A speck count with thousands separators, for reading at a glance. */
export function formatSpecks(specks: bigint): string {
  return `${specks.toLocaleString("en-US")} ${specks === BigInt(1) ? "speck" : "specks"}`;
}

/**
 * A bech32m DUST address shortened for a status line: enough of the prefix
 * to see the network, enough of the end to tell two addresses apart.
 */
export function shortAddress(address: string): string {
  return address.length <= 24 ? address : `${address.slice(0, 16)}…${address.slice(-6)}`;
}
