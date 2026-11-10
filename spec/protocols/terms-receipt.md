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
| `request_hash` | The SHA-256 of the request as the holder's agent sent it (what is hashed is fixed per transport, below) |
| `nonce` | 16 bytes the holder's agent minted for this one request and sent with it |
| `request_id` | The operator's own handle for the request; may be empty |
| `served_at` | When it was served, in unix seconds |
| `custody` | The custody level the operator ran the request at: one of `device_only`, `owned_hardware`, `community_node`, `federated_operator`, `attested_enclave`, `any` |
| `retention_seconds` | How long the operator keeps what it was sent; `0` is "not at all" |
| `training` | What the operator may do with what it was sent, as the policy schema's `derivatives.training` allows: `forbidden`, `allowed` or `requires_payment` |
| `aggregation` | Likewise `derivatives.aggregation`: `forbidden`, `allowed` or `anonymized_only` |
| `resale` | Likewise `derivatives.resale`: `forbidden`, `allowed` or `requires_consent` |

Each of `custody`, `training`, `aggregation` and `resale` takes exactly the
values the S-PAL schema allows for that field, spelled as the schema spells
them. The two integers are at most 2^53 - 1, the range every implementation
holds exactly, as `policy-terms.md` requires of a policy's integers.

The receipt commits the operator to the request as served. It does not
restate the holder's terms: the holder's agent holds those and compares.

## Who signs

The operator signs with the key behind its DID. The holder's agent knows the
operator's DID before the first request, as it knows the operator's address
and its own key for that operator; a receipt is checked against that DID and
no other. The agent never learns the operator's identity from a receipt.

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

1. `operator_did` is the DID the agent was configured with for the operator
   it sent the request to, and the signature verifies for that DID over the
   receipt's canonical bytes.
2. `terms_hash` equals the hash of the terms the agent sent with the request.
3. `request_hash` equals the SHA-256 of the request as the agent sent it,
   computed over the bytes the transport section fixes. Both sides hold those
   bytes, so no shared secret is needed; the holder's own keyed digest in its
   audit record is a different thing and plays no part here.
4. `nonce` is one the agent minted for a request it sent to this operator and
   has not yet accepted a receipt for. The agent mints it, sends it with the
   request, and marks it used on acceptance, so one receipt covers one request
   and a receipt cannot be presented twice, even for two requests whose bytes
   are the same.
5. `served_at` lies within a window around the time the agent itself recorded
   sending the request (the audit record of #93 holds that time). The window
   is the agent's to choose and document; a receipt from well before the
   request was sent, or well after the response arrived, is refused.
6. Every enumerated value is one the schema allows for its field: `custody`
   one of the six custody levels, and each of `training`, `aggregation` and
   `resale` one of its own three values. Any other value, including a
   different spelling, fails.
7. The committed conditions are no weaker than the governing rule's:
   - where the rule states `retention`, `retention_seconds` is at most the
     rule's `max_seconds`;
   - where the rule states `derivatives`, each of `training`, `aggregation`
     and `resale` in the receipt equals the rule's value for that field or is
     `forbidden`; no other value counts as stricter;
   - where the rule states `custody`, the receipt's `custody` is no further
     than the rule's `operator` by the order of the custody levels
     (`device_only` closest, `any` furthest); where it does not, the rule's
     ceiling is `owned_hardware`, as `policy-terms.md` and the agent read a
     silent rule;
   - a condition the rule does not state imposes no requirement; the receipt
     still records what the operator committed to.

A response that arrives without a valid receipt was not served under terms.
What the agent does with it depends on whether this protocol defines a
transport for the call:

- Where it does (the MCP door below), a response at custody `community_node`
  or further without a valid receipt is refused and recorded as such, unless
  the governing rule says receipts are optional. A field for that choice is
  proposed for S-PAL 1.2; until it exists, no rule can opt out.
- Where it does not (a plain HTTP inference API today), no receipt can
  arrive, and the call is recorded as unreceipted in the holder's audit record
  so the holder can see which operators have signed for nothing.

## What a receipt is not

A receipt is not proof that the operator did as it said. Nothing in it shows
what happened to the bytes after they arrived. It is the operator's signed
commitment, the thing that makes the operator answerable to the governance
its custody level names. Evidence that the commitment was kept is a later
level, `attested_enclave`, and a later protocol.

A receipt binds the request, not the response. It says nothing about what
came back, so a dispute about the response has no operator signature to lean
on; binding the response is a later version of this structure if it earns
its place.

## Transport

On the Model Context Protocol door, the holder's agent sends the terms hash
and the nonce in `_meta["earth.freehold/terms"]` of the request (#146), and
the receipt is the value of `_meta["earth.freehold/receipt"]` on the result
of the call it covers. For this transport, `request_hash` is the SHA-256 of
the RFC 8785 canonical JSON of the request's `params` with its `_meta` member
removed, so that both sides hash the same bytes whatever their JSON-RPC
libraries emit.

The receipt is a JSON object with one member per field, plus the signature:

```json
{
  "operator_did": "did:key:z6Mk…",
  "terms_hash": "<64 lowercase hex characters>",
  "request_hash": "<64 lowercase hex characters>",
  "nonce": "<32 lowercase hex characters>",
  "request_id": "req-7f3e2a1c",
  "served_at": 1753000000,
  "custody": "federated_operator",
  "retention_seconds": 0,
  "training": "forbidden",
  "aggregation": "forbidden",
  "resale": "forbidden",
  "signature": "<standard base64 of the signature over the preimage>"
}
```

A verifier refuses the object, before any signature check, when a hash or
the nonce is not lowercase hex of exactly its length, the signature is not
standard base64 (with padding, not the URL-safe alphabet), an integer is
negative, fractional or above 2^53 - 1, or any member is missing or
unknown. The object is metadata for the holder's agent, never content for a
model.

No transport is defined here for a plain HTTP inference API: nothing in such
an API reserves a place for the receipt, and this protocol asks no operator
to add one to a public service. A convention there is a later decision.

## Storage

The holder's agent keeps every accepted receipt beside the audit record of the
call it covers (the record of #93, and its holder-visible form, #145), keyed
so that the two can be read together: the holder's own line says what left
and under which rule; the receipt says what the operator committed to. The
nonce is the key that joins them.

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
