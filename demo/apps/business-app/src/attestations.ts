/**
 * What a proof's DID means to this business.
 *
 * A proof names an ephemeral DID the customer's app issued, and the circuit
 * commits to that DID, so the proof is for it and no other. Whether the DID
 * is the customer's is a separate question, answered by the attestation that
 * came with the approval: the DID's own key signed the request id and the
 * DID. This business holds the request, so it can check that signature
 * itself, against the DID the proof itself names, and need not take the
 * agent's word for either.
 */

import { verifyApprovalAttestation } from "@freehold-earth/identity";
import type { VerificationRequest, VerificationResponse } from "./types";

export type ProofHolder =
  /** The agent did not report whom the proof is for */
  | { kind: "unreported" }
  /** The proof is for no DID, as with an autonomous approval */
  | { kind: "nobody" }
  /** The proof is for this DID and its holder signed the approval of this request */
  | { kind: "attested"; did: string }
  /** The proof names this DID, but nothing shows the DID's holder approved this request */
  | { kind: "unattested"; did: string };

/** The proof's public signals, when the response carries a proof with them. */
function proofSignals(response: VerificationResponse): Record<string, unknown> | null {
  const signals = response.proof?.publicSignals;
  return signals && typeof signals === "object" ? (signals as Record<string, unknown>) : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Who the proof on a resolved verification is for, checked against this
 * request. The DID is read from the proof's own public signals (the agent's
 * `requester_did` is used only when the proof carries none); the proof's
 * commitment must be of that DID; and the attestation must name the same DID
 * and verify over this request's id under that DID's key.
 */
async function decideProofHolder(verification: VerificationRequest): Promise<ProofHolder> {
  const response = verification.response;
  if (!response || response.requester_did === undefined) return { kind: "unreported" };
  const signals = proofSignals(response);
  const named = signals ? signals.requesterDid : response.requester_did;
  if (named === undefined || named === null) return { kind: "nobody" };
  if (typeof named !== "string") return { kind: "unreported" };
  const did = named;
  if (typeof signals?.requesterCommitment === "string" && signals.requesterCommitment !== (await sha256Hex(did))) {
    return { kind: "unattested", did };
  }
  const attestation = response.attestation;
  if (!attestation || attestation.requester_did !== did) return { kind: "unattested", did };
  const signed = await verifyApprovalAttestation(verification.id, {
    requesterDid: attestation.requester_did,
    signature: attestation.signature,
  });
  return signed ? { kind: "attested", did } : { kind: "unattested", did };
}

// Verifications are re-fetched every poll as new objects; the answer for a
// given request, DID, proof and attestation does not change, so it is kept
// and the same object handed back, which lets a caller skip a re-render.
const decided = new Map<string, Promise<ProofHolder>>();

export function proofHolder(verification: VerificationRequest): Promise<ProofHolder> {
  const response = verification.response;
  const signals = response ? proofSignals(response) : null;
  // JSON would fold an absent field into null, and absent and null mean
  // different things above, so each part is tagged with its own presence.
  const part = (value: unknown) => (value === undefined ? "absent" : JSON.stringify(value));
  const key = [
    verification.id,
    part(response?.requester_did),
    part(response?.attestation),
    part(signals?.requesterDid),
    part(signals?.requesterCommitment),
  ].join("|");
  let pending = decided.get(key);
  if (!pending) {
    pending = decideProofHolder(verification);
    decided.set(key, pending);
  }
  return pending;
}
