import { useEffect, useState } from "react";
import { type ProofHolder, proofHolder } from "./attestations";
import type { VerificationRequest } from "./types";

/**
 * Whom a proof is for, checked here rather than taken from the agent: the
 * circuit commits to the DID the proof names, and the attestation that came
 * with the approval shows the DID's holder signed for this very request.
 * Nothing links the DID to any other verification or to the customer's root
 * identity; that is the point of an ephemeral DID.
 */
export function ProofFor({ verification }: { verification: VerificationRequest }) {
  const [holder, setHolder] = useState<ProofHolder | null>(null);
  useEffect(() => {
    let current = true;
    proofHolder(verification)
      .then((h) => {
        if (current) setHolder(h);
      })
      .catch((err: unknown) => {
        // proofHolder answers false rather than throwing for a bad
        // attestation, so this is a fault in the check itself, not a verdict.
        console.error("Could not check whom the proof is for:", err);
        if (current) setHolder({ kind: "unreported" });
      });
    return () => {
      current = false;
    };
  }, [verification]);
  if (!holder || holder.kind === "unreported") return null;
  const good = { marginTop: "0.5rem", fontSize: "0.875rem", color: "#166534" };
  const warn = { ...good, color: "#b45309" };
  switch (holder.kind) {
    case "nobody":
      return <p style={good}>Proof is for no DID (approved without the customer's app naming one).</p>;
    case "attested":
      return (
        <p style={good}>
          Proof is for <code style={{ wordBreak: "break-all" }}>{holder.did}</code>, whose holder
          signed the approval of this request. Checked here, against this request.
        </p>
      );
    case "unattested":
      return (
        <p style={warn}>
          Proof names <code style={{ wordBreak: "break-all" }}>{holder.did}</code>, but no valid
          signature from that DID's holder came with the approval of this request.
        </p>
      );
  }
}
