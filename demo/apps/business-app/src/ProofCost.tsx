import { formatSpecks, proofCost } from "./costs";

/**
 * What a proof cost and who paid: the business pays through the DUST it
 * sponsors to the proof service, so the customer never does.
 */
export function ProofCost({ proof }: { proof: Record<string, unknown> | null | undefined }) {
  const cost = proofCost(proof);
  switch (cost.kind) {
    case "on-chain":
      return (
        <p className="proof-note">
          Proof fee: {formatSpecks(cost.specks)} of DUST, paid from the capacity this business
          sponsors to the proof service. No cost to the customer.
        </p>
      );
    case "offline":
      return <p className="proof-note">Proof generated offline: no network fee, no cost to anyone.</p>;
    case "unreported":
      return null;
  }
}
