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
  const specks = parseSpecks(proof.dustFee);
  return specks === null ? { kind: "unreported" } : { kind: "on-chain", specks };
}

/** A speck count as the services report it: a decimal string, nothing else. */
export function parseSpecks(value: unknown): bigint | null {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
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
 * sponsor and the balance that pays. `ready` is whether proofs can run now,
 * which an address with no DUST behind it does not give.
 */
export interface ProofFees {
  text: string;
  title: string;
  ready: boolean;
}

export function proofFees(zkp: unknown): ProofFees {
  const service = zkp && typeof zkp === "object" ? (zkp as Record<string, unknown>) : {};
  if (service.status !== "healthy") {
    return { text: "Proof fees: proof service unreachable", title: "", ready: false };
  }
  const dust =
    service.dust && typeof service.dust === "object"
      ? (service.dust as Record<string, unknown>)
      : null;
  if (dust && typeof dust.address === "string" && dust.address !== "") {
    const balance = parseSpecks(dust.balance);
    const holding = balance === null ? "balance unknown" : `${formatSpecks(balance)} of DUST`;
    return {
      text: `Proof fees: ${holding} at ${shortAddress(dust.address)}`,
      title: `Sponsor proofs by designating NIGHT's DUST generation to ${dust.address}`,
      ready: balance !== null && balance > BigInt(0),
    };
  }
  switch (service.wallet) {
    case "offline":
      return {
        text: "Proof fees: none, proofs run offline",
        title: "The proof service has no Midnight network, so proofs make no transaction",
        ready: true,
      };
    case "starting":
      return { text: "Proof fees: service wallet starting", title: "", ready: false };
    case "failed":
      return { text: "Proof fees: service wallet failed to start", title: "", ready: false };
    default:
      return { text: "Proof fees: not reported", title: "", ready: false };
  }
}
