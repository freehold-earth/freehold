import { attestApproval, generateEphemeralDID } from "@freehold-earth/identity";
import { describe, expect, it } from "vitest";
import { proofHolder } from "../src/attestations";
import type { VerificationRequest, VerificationResponse } from "../src/types";

function verification(id: string, response?: VerificationResponse): VerificationRequest {
  return {
    id,
    business_id: "biz",
    business_name: "Biz",
    claim: { type: "age", params: { minAge: 18 } },
    policy_id: null,
    context_scope: null,
    service_request_id: null,
    status: "approved",
    created_at: "2026-11-05T10:00:00Z",
    expires_at: "2026-11-05T10:05:00Z",
    response: response ?? null,
  };
}

describe("proofHolder", () => {
  it("is attested when the DID's key signed this request and the proof names that DID", async () => {
    const ephemeral = await generateEphemeralDID();
    const a = await attestApproval("req-1", ephemeral);
    const v = verification("req-1", {
      reason: "verified",
      requester_did: ephemeral.did,
      attestation: { requester_did: a.requesterDid, signature: a.signature },
    });
    expect(await proofHolder(v)).toEqual({ kind: "attested", did: ephemeral.did });
  });

  it("is unattested when the signature is for another request, another DID, or missing", async () => {
    const ephemeral = await generateEphemeralDID();
    const other = await generateEphemeralDID();
    const a = await attestApproval("req-1", ephemeral);
    const attestation = { requester_did: a.requesterDid, signature: a.signature };
    const forOther = verification("req-2", { reason: "verified", requester_did: ephemeral.did, attestation });
    expect(await proofHolder(forOther)).toEqual({ kind: "unattested", did: ephemeral.did });
    const renamed = verification("req-1", { reason: "verified", requester_did: other.did, attestation });
    expect(await proofHolder(renamed)).toEqual({ kind: "unattested", did: other.did });
    const bare = verification("req-1", { reason: "verified", requester_did: ephemeral.did, attestation: null });
    expect(await proofHolder(bare)).toEqual({ kind: "unattested", did: ephemeral.did });
  });

  it("reads the DID from the proof itself, not from what the agent reports beside it", async () => {
    const ephemeral = await generateEphemeralDID();
    const other = await generateEphemeralDID();
    const a = await attestApproval("req-1", ephemeral);
    const attestation = { requester_did: a.requesterDid, signature: a.signature };
    const commitment = async (did: string) => {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did));
      return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
    };
    const proofFor = async (did: string | undefined, requesterCommitment?: string) => ({
      publicSignals: { verified: true, minAge: 18, requesterDid: did, requesterCommitment },
    });

    const honest = verification("req-1", {
      reason: "verified",
      requester_did: ephemeral.did,
      attestation,
      proof: await proofFor(ephemeral.did, await commitment(ephemeral.did)),
    });
    expect(await proofHolder(honest)).toEqual({ kind: "attested", did: ephemeral.did });

    // The agent reports the attested DID, but the proof names another.
    const swapped = verification("req-1", {
      reason: "verified",
      requester_did: ephemeral.did,
      attestation,
      proof: await proofFor(other.did, await commitment(other.did)),
    });
    expect(await proofHolder(swapped)).toEqual({ kind: "unattested", did: other.did });

    // The proof's own commitment is not of the DID it names.
    const relabelled = verification("req-1", {
      reason: "verified",
      requester_did: ephemeral.did,
      attestation,
      proof: await proofFor(ephemeral.did, await commitment(other.did)),
    });
    expect(await proofHolder(relabelled)).toEqual({ kind: "unattested", did: ephemeral.did });

    // A proof that names nobody is for nobody, whatever the agent says.
    const anonymous = verification("req-1", {
      reason: "verified",
      requester_did: ephemeral.did,
      attestation,
      proof: await proofFor(undefined, "00".repeat(32)),
    });
    expect(await proofHolder(anonymous)).toEqual({ kind: "nobody" });

    // A proof's signals without a commitment, or with one of the wrong shape,
    // do not vouch for the DID they name; a nobody proof with a non-zero
    // commitment is not reporting anything coherent.
    for (const commitment of [undefined, "abcd", 42 as unknown as string]) {
      const bare = verification("req-1", {
        reason: "verified",
        requester_did: ephemeral.did,
        attestation,
        proof: await proofFor(ephemeral.did, commitment),
      });
      expect(await proofHolder(bare)).toEqual({ kind: "unattested", did: ephemeral.did });
    }
    const oddNobody = verification("req-1", {
      reason: "verified",
      requester_did: null,
      attestation: null,
      proof: await proofFor(undefined, await commitment(other.did)),
    });
    expect(await proofHolder(oddNobody)).toEqual({ kind: "unreported" });

    // The spelling of the commitment does not matter, its value does.
    const spelled = verification("req-1", {
      reason: "verified",
      requester_did: ephemeral.did,
      attestation,
      proof: await proofFor(ephemeral.did, `0x${(await commitment(ephemeral.did)).toUpperCase()}`),
    });
    expect(await proofHolder(spelled)).toEqual({ kind: "attested", did: ephemeral.did });
  });

  it("hands back the same answer object for the same verification, however often it is re-fetched", async () => {
    const v = verification("req-9", { reason: "x", requester_did: null });
    const first = await proofHolder(v);
    const again = await proofHolder({ ...v, response: { ...v.response! } });
    expect(again).toBe(first);
  });

  it("tells a proof for nobody from one the agent did not report on", async () => {
    expect(await proofHolder(verification("r", { reason: "x", requester_did: null }))).toEqual({
      kind: "nobody",
    });
    expect(await proofHolder(verification("r", { reason: "x" }))).toEqual({ kind: "unreported" });
    expect(await proofHolder(verification("r"))).toEqual({ kind: "unreported" });
  });
});
