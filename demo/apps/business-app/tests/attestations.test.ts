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

  it("tells a proof for nobody from one the agent did not report on", async () => {
    expect(await proofHolder(verification("r", { reason: "x", requester_did: null }))).toEqual({
      kind: "nobody",
    });
    expect(await proofHolder(verification("r", { reason: "x" }))).toEqual({ kind: "unreported" });
    expect(await proofHolder(verification("r"))).toEqual({ kind: "unreported" });
  });
});
