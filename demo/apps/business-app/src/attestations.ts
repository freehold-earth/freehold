/**
 * What a proof's DID means to this business.
 *
 * A proof names an ephemeral DID the customer's app issued, and the circuit
 * commits to that DID, so the proof is for it and no other. Whether the DID
 * is the customer's is a separate question, answered by the attestation that
 * came with the approval: the DID's own key signed the request id and the
 * DID. This business holds the request, so it can check that signature
 * itself and need not take the agent's word for it.
 */

import { verifyApprovalAttestation } from "@freehold-earth/identity";
import type { VerificationRequest } from "./types";

export type ProofHolder =
  /** The agent did not report whom the proof is for */
  | { kind: "unreported" }
  /** The proof is for no DID, as with an autonomous approval */
  | { kind: "nobody" }
  /** The proof is for this DID and its holder signed the approval of this request */
  | { kind: "attested"; did: string }
  /** The proof names this DID, but nothing shows the DID's holder approved this request */
  | { kind: "unattested"; did: string };

/**
 * Who the proof on a resolved verification is for, checked against this
 * request: the attestation must name the same DID the proof does and its
 * signature must verify over this request's id under that DID's key.
 */
export async function proofHolder(verification: VerificationRequest): Promise<ProofHolder> {
  const response = verification.response;
  if (!response || response.requester_did === undefined) return { kind: "unreported" };
  const did = response.requester_did;
  if (did === null) return { kind: "nobody" };
  const attestation = response.attestation;
  if (!attestation || attestation.requester_did !== did) return { kind: "unattested", did };
  const signed = await verifyApprovalAttestation(verification.id, {
    requesterDid: attestation.requester_did,
    signature: attestation.signature,
  });
  return signed ? { kind: "attested", did } : { kind: "unattested", did };
}
