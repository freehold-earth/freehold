/**
 * What a proof cost, read from the proof the agent stored. The proof service
 * names its method as "on-chain" or "offline" and nothing else. An on-chain
 * proof reports the DUST its transactions cost, in specks, as a decimal
 * string (`dustFee`); the service's wallet paid it from the capacity the
 * business sponsored to it (ADR-007's business-pays model), so the customer
 * paid nothing. An offline proof made no transaction and cost nothing. A
 * method this app does not know is left unreported rather than guessed at.
 */
export type ProofCost =
  | { kind: "on-chain"; specks: bigint }
  | { kind: "offline" }
  | { kind: "unreported" };

export function proofCost(proof: Record<string, unknown> | null | undefined): ProofCost {
  if (!proof) return { kind: "unreported" };
  if (proof.verificationMethod === "offline") return { kind: "offline" };
  if (proof.verificationMethod !== "on-chain") return { kind: "unreported" };
  const specks = parseSpecks(proof.dustFee);
  return specks === null ? { kind: "unreported" } : { kind: "on-chain", specks };
}

/**
 * A speck count as the services report it: a decimal string, nothing else,
 * and no longer than any balance could be (40 digits exceeds any 128-bit
 * count), so a stored proof cannot make the page chew on a huge number.
 */
export function parseSpecks(value: unknown): bigint | null {
  return typeof value === "string" && /^[0-9]{1,40}$/.test(value) ? BigInt(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A speck count with thousands separators, for reading at a glance. */
export function formatSpecks(specks: bigint): string {
  return `${specks.toLocaleString("en-US")} ${specks === BigInt(1) ? "speck" : "specks"}`;
}

/**
 * A bech32m DUST address shortened for a status line: the whole prefix up to
 * the separator, so the network stays readable, and the tail, to tell two
 * addresses apart.
 */
export function shortAddress(address: string): string {
  const separator = address.lastIndexOf("1");
  const head = separator + 5;
  if (separator < 0 || address.length <= head + 7) return address;
  return `${address.slice(0, head)}…${address.slice(-6)}`;
}

/**
 * What the status bar says about paying for proofs, from the proof service's
 * entry in the agent's status aggregate: unreachable, running offline (proofs
 * cost nothing), a wallet still starting or failed, or the DUST address to
 * sponsor and the balance that pays. `funded` is whether there is DUST to pay
 * with at all, or no fee to pay. Whether the balance covers one proof's fee is
 * only known at proof time, when the service estimates the fee and refuses
 * the proof if the balance falls short; the bar cannot promise that.
 */
export interface ProofFees {
  text: string;
  title: string;
  funded: boolean;
}

export function proofFees(zkp: unknown): ProofFees {
  const service = isRecord(zkp) ? zkp : {};
  if (service.status !== "healthy") {
    return { text: "Proof fees: proof service unreachable", title: "", funded: false };
  }
  if (service.wallet === "offline") {
    return {
      text: "Proof fees: none, proofs run offline",
      title: "The proof service has no Midnight network, so proofs make no transaction",
      funded: true,
    };
  }
  const dust = isRecord(service.dust) ? service.dust : null;
  if (dust && typeof dust.address === "string" && dust.address !== "") {
    const balance = parseSpecks(dust.balance);
    const holding = balance === null ? "balance unknown" : `${formatSpecks(balance)} of DUST`;
    return {
      text: `Proof fees: ${holding} at ${shortAddress(dust.address)}`,
      title: `Sponsor proofs by designating NIGHT's DUST generation to ${dust.address}; whether the balance covers a proof's fee is decided at proof time`,
      funded: balance !== null && balance > BigInt(0),
    };
  }
  switch (service.wallet) {
    case "ready":
      return { text: "Proof fees: no sponsor address reported", title: "", funded: false };
    case "starting":
      return { text: "Proof fees: service wallet starting", title: "", funded: false };
    case "failed":
      return { text: "Proof fees: service wallet failed to start", title: "", funded: false };
    default:
      return { text: "Proof fees: not reported", title: "", funded: false };
  }
}
