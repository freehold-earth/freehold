# MCP Terms Extension

Version: 1.0

Extension identifier: `earth.freehold/spal`

## Purpose

The Model Context Protocol (MCP) standardises how a client calls a tool on a
server. It says nothing about what the server may do with the data
afterwards, and it carries no terms. This extension is how a holder's agent
tells an MCP server which terms a call is made under, and how the server
answers with its signature.

It defines three things and nothing else:

- how each side says it speaks the extension;
- what the agent puts on a request: the terms the call is made under and the
  label the receipt will name it by;
- what the server puts on the answer: a signed terms receipt
  ([`terms-receipt.md`](terms-receipt.md)), or a refusal that says why.

The terms themselves are those of [`policy-terms.md`](policy-terms.md). The
receipt, its signature and what the agent checks are those of
`terms-receipt.md`. This document is the transport that file calls "the MCP
door", written out in full.

It is written against the MCP specification of 2026-07-28, the first with
extensions: opted into by both sides, declared on every request, with no
handshake to remember.

## Saying you speak it

**The agent** lists the extension in its capabilities on every request, as
MCP requires of any capability:

```json
"_meta": {
  "io.modelcontextprotocol/clientCapabilities": {
    "extensions": { "earth.freehold/spal": {} }
  }
}
```

The settings object is empty in this version.

**The server** lists it in the result of `server/discover`, with the
conditions it serves under:

```json
"capabilities": {
  "extensions": {
    "earth.freehold/spal": {
      "operator_did": "did:key:z6Mk…",
      "custody": "federated_operator",
      "retention_seconds": 0,
      "training": "forbidden",
      "aggregation": "forbidden",
      "resale": "forbidden",
      "terms": "required"
    }
  }
}
```

| Member | What it says |
|---|---|
| `operator_did` | The identity the server signs receipts with |
| `custody`, `retention_seconds`, `training`, `aggregation`, `resale` | What the operator commits to for a request it serves, with the values `terms-receipt.md` gives the receipt fields of the same names |
| `terms` | `required` if the server refuses a request that carries no terms; `optional` if it serves such a request as plain MCP |

All seven are present. They let an agent see, before anything leaves the
holder's machine, that an operator cannot meet a rule, and not send.

What `server/discover` returns is unsigned. It is a statement of intent, not
a commitment: the commitment is the receipt. In particular an agent never
takes the operator's identity from it. The agent is configured with the DID
of each operator it uses, and a `server/discover` answer naming another is a
reason to stop, not a new identity to trust.

## What the agent sends

A request made under terms carries them in `_meta["earth.freehold/terms"]`:

```json
"_meta": {
  "earth.freehold/terms": {
    "terms_hash": "<64 lowercase hex characters>",
    "context_scope": "notes/2026/meeting-notes",
    "nonce": "<32 lowercase hex characters>",
    "commitment": "<64 lowercase hex characters>"
  }
}
```

| Member | What it says |
|---|---|
| `terms_hash` | The hash of the terms the call is made under (`policy-terms.md`) |
| `context_scope` | The scope of the data the call carries. It picks out the rule in the terms that governs this call |
| `nonce` | 16 bytes the agent minted for this one request (`terms-receipt.md`) |
| `commitment` | The agent's keyed commitment to the request (`terms-receipt.md`), over the request bytes that file defines for this transport |
| `terms` | Optional. The terms themselves, as the JSON object whose canonical form hashes to `terms_hash`. Sent only when the server has asked for them; see the next section |

Any request may carry terms. The ones that carry a holder's data to a server
are `tools/call`, `resources/read` and `prompts/get`, and an agent sends
terms on each of those it makes for a holder.

`context_scope` tells the operator which of the holder's rules is in play,
and so what kind of data the call concerns. The operator needs that to know
whether it can honour the rule, and it is about to receive the data itself.
It is the one thing in this object that describes the data; nothing else
does.

One request carries one scope. A call that would carry data from two scopes
is two calls, each under its own rule (several scopes in one request are a
later version, with #150).

## Getting the terms to the server

The server needs the terms once per hash, not once per call. So the agent
sends only the hash, and the server asks when it meets a hash it has not
seen:

1. The agent sends the request with `terms_hash` and no `terms`.
2. A server that holds the terms for that hash goes on. One that does not
   refuses with the reason `terms_unknown` (below) and keeps nothing of the
   request.
3. The agent sends the request again with the `terms` member added, under a
   new nonce and commitment: a refused request's nonce is spent, as every
   nonce is once sent.
4. The server hashes the terms exactly as it was given them: the SHA-256 of
   the RFC 8785 canonical JSON of the `terms` object, every member included.
   It does not run the export of `policy-terms.md` over them first, which
   would drop members it does not recognise and let two different objects
   share a hash. If the result is not `terms_hash` it refuses with
   `terms_mismatch` and stores nothing. If it is, the server stores the
   terms under the hash and goes on.

Because the hash covers every byte of the object, nothing can be added to
terms without changing their hash, and whoever sends the terms for a hash
sends the same terms. Terms the server stores and then cannot understand or
honour are refused each time they are used, which is the right answer for
those terms and affects no others.

Adding `terms` does not change what the commitment covers, since `_meta` is
not part of the request bytes. A server may forget terms it has stored; the
agent meets `terms_unknown` again and sends them again.

The server is never given an address to fetch terms from. A holder's agent
is usually not reachable from the internet, so it has nowhere to serve them,
and a server that fetches whatever address a caller names can be pointed at
its own internal network. Terms are a few hundred bytes of JSON, sent once.

## What the server checks

A server that advertises the extension treats a request carrying
`_meta["earth.freehold/terms"]` as follows, in this order, and refuses at
the first check that fails:

1. **The object is well formed.** Every member is one this document names;
   `terms_hash`, `nonce` and `commitment` are lowercase hex of exactly their
   lengths; `context_scope` is non-empty text. The request's `params` is a
   JSON object, as the receipt's request bytes require.
2. **It has the terms.** As the section above describes.
3. **It understands the terms.** Every rule's conditions are among
   `identity`, `proofs`, `retention`, `derivatives`, `payment` and `custody`,
   and every value in `retention`, `derivatives` and `custody` is one the
   S-PAL schema allows. A condition the server does not understand is a
   refusal, never something to skip: the holder asked for it.
4. **A rule governs the scope.** The governing rule is the rule whose
   `context_scope` is the request's, or failing that the rule for the nearest
   scope above it (`notes` governs `notes/2026/meeting-notes` when nothing
   more specific does). Where two rules name the same scope, the first in the
   terms' own order governs, as `policy-terms.md` has the agent do. No
   governing rule is a refusal.
5. **It can honour the governing rule.** The conditions that bind an
   operator are `custody`, `retention` and `derivatives`:
   - the operator's custody level is no further than the rule's
     `custody.operator`, by the order `device_only` < `owned_hardware` <
     `community_node` < `federated_operator` < `attested_enclave` < `any`. A
     rule that says nothing about custody has the ceiling `owned_hardware`;
   - where the rule's `custody.attestation_required` is true, the operator
     can attest. No attestation protocol is defined yet, so every operator
     refuses such a rule today;
   - where the rule states `retention.max_seconds`, the operator keeps what
     it is sent for no longer than that;
   - where the rule states `derivatives`, the operator's commitment for each
     of `training`, `aggregation` and `resale` equals the rule's value or is
     `forbidden`.

   `identity`, `proofs` and `payment` bind a business asking for a holder's
   data in the exchange of `policy-terms.md`. They ask nothing of an operator
   serving the holder's own call, and the server does not act on them.

These are the checks the agent makes of the receipt in `terms-receipt.md`,
made first by the server of itself. An operator that passes them and signs
is making a commitment the agent will accept; one that would fail them says
so before it touches the data.

A request without `_meta["earth.freehold/terms"]` is plain MCP. A server
whose `terms` setting is `required` refuses it with `terms_required`; one
whose setting is `optional` serves it and signs nothing.

## Refusal

A refusal is a JSON-RPC error on the request. Its meaning is carried in
`error.data`, under the extension's own key:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32010,
    "message": "terms refused: custody",
    "data": {
      "earth.freehold/refusal": {
        "reason": "cannot_honour",
        "condition": "custody",
        "terms_hash": "<64 lowercase hex characters>"
      }
    }
  }
}
```

| Reason | When | Other members |
|---|---|---|
| `terms_required` | The request carries no terms and the server requires them | none |
| `terms_malformed` | Check 1 failed | none |
| `terms_unknown` | The server does not hold the terms for this hash | `terms_hash` |
| `terms_mismatch` | The terms sent do not hash to `terms_hash` | `terms_hash` |
| `condition_not_understood` | Check 3 failed | `terms_hash`, and `condition`: the name the server did not understand |
| `scope_not_governed` | Check 4 failed | `terms_hash` |
| `cannot_honour` | Check 5 failed | `terms_hash`, and `condition`: one of `custody`, `attestation`, `retention`, `training`, `aggregation`, `resale` |

An agent reads `reason`, never the code or the message. MCP leaves the codes
from -32000 to -32019 to implementations and forbids giving them a meaning
across implementations, so the code says only "refused by this extension";
`-32010` is the one a Freehold server sends. `message` is for a person
reading a log.

A server that refuses has not served the request. It does not pass it on,
and it keeps nothing of it beyond its own audit line, which holds the
reason, the terms hash and the nonce, and none of the request's content.

A refusal is not signed. It commits the operator to nothing, and an agent
that is refused sends no data on the strength of it.

## What the server returns

A server that serves a request made under terms puts the receipt in
`_meta["earth.freehold/receipt"]` on the result, as the JSON object
`terms-receipt.md` defines. It signs with the key of the `operator_did` it
advertises, and it echoes `terms_hash`, `nonce` and `commitment` as they
were sent.

Every result of such a request carries a receipt, whatever its kind. MCP
lets a server answer with a request for more input before the final result.
The data has arrived either way, so that answer carries a receipt too, and
the agent's next request, which is a new request with new bytes, goes under
a new nonce and commitment and earns a receipt of its own. One request, one
receipt.

An error other than a refusal carries no receipt: a JSON-RPC error has no
`_meta`. The agent records such a call as sent and unreceipted. Signing for
a request that then failed is left to a later version.

## What the agent does

A refusal that arrives after the request was sent is a refusal that arrives
after the data did. So the agent settles what it can before it sends, and
sends nothing when any of these fails:

- **A rule governs the scope.** The agent holds the terms, so it finds the
  governing rule itself, the way the server will. No governing rule, no
  request.
- **The rule does not ask for attestation.** No operator can attest yet, so
  a rule with `custody.attestation_required` true goes to no server.
- **The server's advertised conditions satisfy the rule.** The agent reads
  the server's `server/discover` answer before the first request it makes
  under terms, and checks the advertised `custody`, `retention_seconds`,
  `training`, `aggregation` and `resale` against the governing rule as
  `terms-receipt.md` has it check a receipt. It may keep the answer and
  reuse it; a server whose conditions have changed since will say so in its
  receipt or its refusal.

Nothing has left the holder's machine at that point. The server makes the
same checks again on its side: the agent's are there to protect the data,
the server's to protect the operator from signing what it cannot keep.

On the result, the agent takes `_meta["earth.freehold/receipt"]` and
verifies it as `terms-receipt.md` says, all checks or none. What it does
with a result that carries no valid receipt is also that file's to say.

A server that does not advertise the extension gets plain MCP or nothing.
Which one is the holder's rule to decide, not the agent's.

## Keeping the model's context clean

An MCP result's `content` goes to a model. `_meta` does not: it is protocol
metadata for the client. Terms, labels, receipts and refusals all travel in
`_meta` or in `error.data` and never in `content`, tool descriptions,
prompts or resource bodies. An agent hands none of them to a model. A
server's refusal `message` is text an operator chose; the agent logs it and
does not show it to a model either.

## What this does not do

- It does not make the server keep its word. A receipt is a signed
  commitment, and `terms-receipt.md` says what that is and is not worth.
- It does not hide the scope from the operator, or the fact that a call was
  made.
- It does not authenticate the agent to the server. MCP's own authorisation
  does that, and it is unchanged.
- It does not cover notifications, or the streams of `subscriptions/listen`.
  Nothing a holder's agent sends on them is under terms in this version.

## Relation to the other protocols

`policy-terms.md` defines the terms and their hash. `terms-receipt.md`
defines the receipt, the request bytes it commits to, and the agent's checks.
This document carries both over MCP. A proxy an operator runs in front of an
MCP server (#148) implements the server's side of it for a server that does
not.
