# Terms Receipt Protocol

Version: 1.0

## Purpose

When a holder's data leaves their machine for an operator, the holder has
evidence on their own side: the business echoes the hash of the terms it
accepted (`policy-terms.md`), and the holder's agent writes a record of every
model call before it makes it. The operator that served the request has
signed nothing. The custody level `federated_operator` is defined as an
operator accountable through community governance, and accountability needs
the operator's own signature on what it did.

A **terms receipt** is that signature: one signed statement per request
served under a terms hash, saying which terms, which request, when, and the
conditions the operator commits to for that request. The holder's agent
checks it and keeps it beside its own record, so a dispute can put the
operator's commitment next to the holder's log.

## What a receipt says

A receipt is the structure `spal/receipt/v1` of
[`preimage-encoding.md`](preimage-encoding.md), signed by the operator over
its canonical bytes. Its fields:

| Field | What it says |
|---|---|
| `operator_did` | Who served the request and signs for it |
| `terms_hash` | The SHA-256 of the terms the request was served under, as `policy-terms.md` defines it |
| `request_hash` | The SHA-256 of the request bytes served, exactly as the holder's agent sent them |
| `request_id` | The operator's own handle for the request; may be empty |
| `served_at` | When it was served, in unix seconds |
| `custody` | The custody level the operator ran the request at, as text |
| `retention_seconds` | How long the operator keeps what it was sent; `0` is "not at all" |
| `training`, `aggregation`, `resale` | What the operator may do with what it was sent, each a derivative permission as text |

The receipt commits the operator to the request as served. It does not
restate the holder's terms: the holder's agent holds those and compares.

## Who signs

The operator signs with the key behind its DID.

- A test operator, or a small one, signs as `did:key`: the key is the
  identity, and a verifier needs nothing but the DID to check the signature.
- An organisation signs as `did:web`: the DID names a domain, and the
  verifier resolves the signing key from a document the organisation
  publishes there. How a verifier resolves and caches that document, and what
  it does when the document changes, is decided with #136, which needs the
  same answer for a business that signs its acceptance of terms. Until then an
  implementation that verifies only `did:key` is conforming, and a `did:web`
  receipt it cannot resolve is no receipt.

The signature is over the canonical preimage bytes, the way every other
signed structure in `preimage-encoding.md` is signed; it is not part of the
preimage.

## Verification

The holder's agent accepts a receipt only when all of the following hold.
A receipt that fails any one is no receipt.

1. The signature verifies for `operator_did` over the receipt's canonical
   bytes.
2. `terms_hash` equals the hash of the terms the agent sent with the request.
3. `request_hash` equals the SHA-256 of the request bytes the agent sent. Both
   sides hold those bytes, so no shared secret is needed; the holder's own
   keyed digest in its audit record is a different thing and plays no part
   here.
4. `served_at` lies within a window of the agent's own clock that the agent
   chooses and documents; a receipt from the far past or the future is
   refused.
5. The committed conditions are no weaker than the governing rule's:
   - `retention_seconds` is at most the rule's `retention.max_seconds`;
   - for each of `training`, `aggregation` and `resale`, where the rule says
     `forbidden` the receipt says `forbidden`, and otherwise the receipt's
     value is the rule's or stricter, `forbidden` being the strictest;
   - `custody` is no further than the rule's custody ceiling, by the order of
     the custody levels (`device_only` closest, `any` furthest).
6. `operator_did` is the operator the agent sent the request to, where the
   agent knows that identity in advance; an agent that does not yet know it
   records the DID the receipt names and holds the operator to it from then
   on.

A response that comes without a valid receipt was not served under terms.
What follows from that is the governing rule's decision, through its custody
and enforcement conditions: a rule may accept such a response, record it as
unreceipted, or refuse to use it.

## What a receipt is not

A receipt is not proof that the operator did as it said. Nothing in it shows
what happened to the bytes after they arrived. It is the operator's signed
commitment, the thing that makes the operator answerable to the governance
its custody level names. Evidence that the commitment was kept is a later
level, `attested_enclave`, and a later protocol.

## Transport

On the Model Context Protocol door, the receipt is the value of
`_meta["earth.freehold/receipt"]` on the result of the call it covers (#146).
It is a JSON object with one member per field, plus the signature:

```json
{
  "operator_did": "did:key:z6Mk…",
  "terms_hash": "<64 hex characters>",
  "request_hash": "<64 hex characters>",
  "request_id": "req-7f3e2a1c",
  "served_at": 1753000000,
  "custody": "federated_operator",
  "retention_seconds": 0,
  "training": "forbidden",
  "aggregation": "forbidden",
  "resale": "forbidden",
  "signature": "<base64 of the signature over the preimage>"
}
```

The two hashes travel as lowercase hex, the signature as base64, and the
integers as JSON numbers; a value outside the safe-integer range is refused
as `policy-terms.md` refuses one. The object is metadata for the holder's
agent, never content for a model.

No transport is defined here for a plain HTTP inference API: nothing in such
an API reserves a place for the receipt, and this protocol asks no operator
to add one to a public service. A convention there is a later decision.

## Storage

The holder's agent keeps every accepted receipt beside the audit record of the
call it covers (the record of #93, and its holder-visible form, #145), keyed
so that the two can be read together: the holder's own line says what left
and under which rule; the receipt says what the operator committed to.

## Relation to the terms protocol and the audit record

The terms protocol gives both sides one hash for what was agreed. The audit
record gives the holder a line for what left. The receipt gives the holder the
operator's signature for what was served. Together they are the paper trail
on both sides of one request; none of the three replaces another.

## Test vectors

The receipt's canonical encoding is pinned by the `receipt-served` and
`receipt-empty-request-id` vectors in
[`../schemas/encoding/v1.0/test-vectors.json`](../schemas/encoding/v1.0/test-vectors.json),
which the spec package and the identity package both reproduce byte for
byte.
