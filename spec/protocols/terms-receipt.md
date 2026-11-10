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

The receipt signs what the operator agreed to, never what it saw. Nothing in
it is derived from the request's content in a form anyone could reverse: the
request is named by a nonce and by a commitment only the holder can open.

## What a receipt says

A receipt is the structure `spal/receipt/v1` of
[`preimage-encoding.md`](preimage-encoding.md), signed by the operator over
its canonical bytes. Its fields:

| Field | What it says |
|---|---|
| `operator_did` | Who served the request and signs for it |
| `terms_hash` | The SHA-256 of the terms the request was served under, as `policy-terms.md` defines it |
| `nonce` | 16 bytes the holder's agent minted for this one request and sent with it |
| `commitment` | 32 bytes the holder's agent computed over the request under a key only the holder has, sent with the request; the operator signs it as given |
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

## The commitment

The holder's agent names the request's content by a commitment the operator
cannot open and a third party cannot test guesses against. A prompt is a
known template around a few guessable values, so a plain hash of it would be
no secret at all; the audit record of #93 keeps a keyed digest for the same
reason, and the receipt carries the same kind of value.

- The agent derives a key for this one request from the holder's audit key,
  the operator and the nonce:
  `request_key = HMAC-SHA256(audit_key, "spal/receipt/v1" || 0x00 || operator_did || 0x00 || nonce)`,
  where the audit key is the one the agent already derives from the vault
  secret for its audit record, `operator_did` is the UTF-8 bytes of the DID
  (a DID carries no NUL byte, so the separators are unambiguous), and `||` is
  byte concatenation. The operator's DID is in the derivation so that two
  requests to two operators that happen to share a nonce value never share a
  key. The label `spal/receipt/v1` is the structure's registry entry; a later
  version of the structure derives under its own label.
- The commitment is `HMAC-SHA256(request_key, request_bytes)`, where
  `request_bytes` are the bytes the transport in use fixes; a transport that
  does not define them cannot carry a receipt.
- The agent sends the commitment with the request; the operator copies it
  into the receipt and signs. The operator attests that it served the request
  the holder labelled this way; it does not, and cannot, verify the label.

The holder can later open one request, in a dispute, by revealing that
request's `request_key` and the request bytes; a reader recomputes the
commitment and checks the operator's signature over it. Opening one request
reveals nothing about any other, since each has its own key. Without the
key, the commitment reveals nothing; and the holder cannot open it to a
different request, since that would mean finding a second input for the same
keyed hash.

What that establishes, exactly: the operator signed the holder's label for a
request it served under these terms with these conditions, and the holder
can show which request the label stands for. The operator never had the key,
so it signed the label blind; its signature says "I served the request
labelled this way", not "I checked the label". An operator that disputes
the opened request must produce its own record of what it received. The
receipt binds the operator to the terms and the conditions beyond doubt, and
binds it to the content by way of a label only the holder can open.

The audit record of #93 should carry this same per-request digest for the
call, so the record and the receipt bear one label; that change to the agent
is a follow-up to this document.

## Who signs

The operator signs with the key behind its DID. The holder's agent knows the
operator's DID before the first request, as it knows the operator's address
and its own key for that operator; a receipt is checked against that DID and
no other. The agent never learns the operator's identity from a receipt.

- A test operator, or a small one, signs as `did:key`: the key is the
  identity, and a verifier needs nothing but the DID to check the signature.
  Version 1 of the transport below carries a bare signature and is defined
  for `did:key` signers with an Ed25519 key (the `z6Mk` form the identity
  package produces): the signature is the raw 64-byte Ed25519 signature over
  the preimage bytes. Any other key type is a later transport version.
- An organisation signs as `did:web`: the DID names a domain, and the
  verifier resolves the signing key from a document the organisation
  publishes there. A `did:web` document may hold several keys, so a receipt
  from one must name the key that signed; that field, and how a verifier
  resolves and caches the document, are decided with #136, which needs the
  same answers for a business that signs its acceptance of terms, and arrive
  as a new version of the transport. Until then a `did:web` receipt is no
  receipt.

The signature is over the canonical preimage bytes, the way every other
signed structure in `preimage-encoding.md` is signed; it is not part of the
preimage.

## Verification

The holder's agent accepts a receipt only when all of the following hold.
The checks are one atomic step: a receipt that fails any one is no receipt,
and nothing is stored; the nonce it names stays spent, as every nonce is once
sent, so the failed receipt cannot be retried under it.

1. `operator_did` is the DID the agent was configured with for the operator
   it sent the request to, and the signature verifies for that DID over the
   receipt's canonical bytes.
2. `terms_hash` equals the hash of the terms the agent sent with the request.
3. `nonce` is one the agent minted for a request it sent to this operator and
   has not yet accepted a receipt for. The agent mints it, sends it with the
   request, and marks it used on acceptance, so one receipt covers one request
   and a receipt cannot be presented twice, even for two requests whose bytes
   are the same. A nonce is scoped to the operator it was sent to, and is
   spent by the attempt it was minted for: a request that fails, times out or
   is abandoned, or a receipt that fails these checks, never makes its nonce
   available again; the next attempt mints a new one.
4. `commitment` equals the commitment the agent sent with that request.
5. `served_at` lies within a window around the time the agent itself recorded
   sending the request (the audit record of #93 holds that time). The window
   is the agent's to choose and document; a receipt from well before the
   request was sent, or well after the response arrived, is refused.
6. Every enumerated value is one the schema allows for its field: `custody`
   one of the six custody levels, and each of `training`, `aggregation` and
   `resale` one of its own three values. Any other value, including a
   different spelling, fails.
7. The committed conditions are no weaker than the governing rule's:
   - `custody` is no further than the rule's ceiling by the order of the
     custody levels, `device_only` < `owned_hardware` < `community_node` <
     `federated_operator` < `attested_enclave` < `any`. A rule that says
     nothing about custody has the ceiling `owned_hardware`, as
     `policy-terms.md` and the agent read a silent rule, so this check always
     applies;
   - where the rule states `retention`, `retention_seconds` is at most the
     rule's `max_seconds`; where it does not, the receipt's value is recorded
     and nothing is required of it;
   - where the rule states `derivatives`, each of `training`, `aggregation`
     and `resale` in the receipt equals the rule's value for that field or is
     `forbidden`; no other value counts as stricter;
   - a retention or derivatives condition the rule does not state imposes no
     requirement: the verifier enforces what the holder asked for, and the
     receipt still records what the operator committed to.

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

Opening a commitment reveals the request. Proving a property of a committed
request without revealing it, to community governance for instance, is a
zero-knowledge proof over the same commitment and needs no change to the
receipt; it belongs with the audit trail work (#15) once there is a dispute
process to serve.

## Transport

On the Model Context Protocol door, the holder's agent sends the terms hash,
the nonce and the commitment in `_meta["earth.freehold/terms"]` of the
request (#146), and the receipt is the value of
`_meta["earth.freehold/receipt"]` on the result of the call it covers. For
this transport, `request_bytes` are the UTF-8 bytes of the RFC 8785
canonical JSON of the object `{"method": <the request's method>, "params":
<the request's params with its top-level "_meta" member removed>}`, so that
the agent commits to the same bytes whatever its JSON-RPC library emits and
to the operation as well as its arguments. `params` must be a JSON object
for this transport; an absent `params` commits as `{}`. The JSON-RPC id and
the rest of the frame are not part of it.

The receipt is a JSON object with one member per field, plus the signature:

```json
{
  "operator_did": "did:key:z6Mk…",
  "terms_hash": "<64 lowercase hex characters>",
  "nonce": "<32 lowercase hex characters>",
  "commitment": "<64 lowercase hex characters>",
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

A verifier refuses the object, before any signature check, when a hex field
is not lowercase hex of exactly its length, the signature is not canonical
standard base64 (the `A-Z a-z 0-9 + /` alphabet, padded, no whitespace, and
re-encoding the decoded bytes gives the same text), an integer is negative,
fractional or above 2^53 - 1, or any member is missing or unknown. The
object is metadata for the holder's agent, never content for a model.

No transport is defined here for a plain HTTP inference API: nothing in such
an API reserves a place for the receipt, and this protocol asks no operator
to add one to a public service. A convention there is a later decision.

## Storage

The holder's agent keeps every accepted receipt beside the audit record of the
call it covers (the record of #93, and its holder-visible form, #145). The
storage key is the pair (`operator_did`, `nonce`), since a nonce is scoped
to its operator. Under that key the two read as one: the holder's own line
says what left and under which rule, and the receipt says what the operator
committed to.

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
byte. The commitment values in the vectors are placeholder bytes: the
vectors pin the encoding, not a commitment.
