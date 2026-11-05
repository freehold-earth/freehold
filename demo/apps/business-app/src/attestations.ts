/**
 * What a proof's DID means to this business.
 *
 * A proof names an ephemeral DID the customer's app issued, and the circuit
 * commits to that DID, so the proof is for it and no other. Whether the DID
 * is the customer's is a separate question, answered by the attestation that
 * came with the approval: the DID's own key signed the request id and the
 * DID. This business holds the request, so it can check that signature
 * itself, against the DID the proof itself names. What it reads is the proof
 * as the agent stored it; that the circuit's ledger holds the same
 * commitment is the proof verifier's check (the SDK's verify()), not this
 * app's, so a verdict here is about the stored proof and the attestation.
 */

import { verifyApprovalAttestation } from "@freehold-earth/identity";
import type { VerificationRequest, VerificationResponse } from "./types";

export type ProofHolder =
  /** The agent did not report whom the proof is for */
  | { kind: "unreported" }
  /** The check itself could not run here (no WebCrypto on an insecure origin, for one) */
  | { kind: "unchecked" }
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

/** SHA-256 of the text's UTF-8 bytes, as the circuit's commitment is defined. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ZERO_COMMITMENT = "00".repeat(32);

/** A commitment as the proof spells it, as lowercase hex without 0x; null unless it is 32 bytes of hex. */
function commitmentHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = (value.startsWith("0x") ? value.slice(2) : value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
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
  // Every verdict below is about the proof: without its signals there is
  // nothing to vouch for, whatever the agent reports beside it.
  const signals = proofSignals(response);
  if (!signals) return { kind: "unreported" };
  const named = signals.requesterDid;
  if (typeof named !== "string" && named !== undefined && named !== null) return { kind: "unreported" };
  // A proof's signals always carry its commitment; one without it, or with a
  // commitment of some other DID, is not vouching for the DID it names.
  const committed = commitmentHex(signals.requesterCommitment);
  const attestation = response.attestation;
  if (named === undefined || named === null) {
    // An attestation means the customer named a DID; a proof for nobody
    // beside it is not "approved without naming one".
    return committed === ZERO_COMMITMENT && !attestation ? { kind: "nobody" } : { kind: "unreported" };
  }
  const did = named;
  if (committed !== (await sha256Hex(did))) return { kind: "unattested", did };
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
// Bounded: the oldest answers go once a session has seen many verifications.
const decided = new Map<string, Promise<ProofHolder>>();
const DECIDED_LIMIT = 500;

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
    if (decided.size >= DECIDED_LIMIT) decided.delete(decided.keys().next().value as string);
    decided.set(key, pending);
    // A failure of the check itself is not an answer; let the next poll retry.
    pending.catch(() => decided.delete(key));
  }
  return pending;
}
