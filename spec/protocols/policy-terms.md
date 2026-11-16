# Policy Terms

Status: adopted 2026-11-07 (design: `docs/superpowers/specs/2026-11-07-policies-in-the-context-store-design.md`, #134).

## Purpose

A business that asks an end-user to prove something is asking under the
end-user's S-PAL policy. The business must be able to see what it is agreeing
to, and both sides must later be able to show which terms were in force,
without the business learning who the end-user is.

A policy's id is `spal:{owner DID}:{name}`. The owner is the end-user's root
DID, which the identity privacy model keeps from every third party. So the
id never travels to a business. What travels is the policy's **terms**, and
what the business echoes back is a hash of them.

## A scope is a storage key

A rule's `context_scope` is a path such as `personal/age`, and it is also
the key the governed data is stored under in the end-user's context store.
When the agent reads for a scope, under a policy's rule for it, it reads
the one entry under that key: nothing beside it (`personal/name`) and
nothing under it (`personal/age/history`), since an entry under a scope has
a scope of its own and is governed by its own rule. A rule therefore
governs exactly what it names, and what leaves the end-user's machine under a
rule is the entry it names and no more. A rule may still name a scope above
others (`personal`), in which case it is the governing rule for every scope
under it that has no more specific rule; it does not thereby read them.

## Terms

The terms of a policy are its contractual content and nothing else:

| Kept | Why |
|---|---|
| `version` | which S-PAL the rules are written in |
| each rule's `context_scope` and `conditions` | what is governed and how, including (1.1) whose machine may work on it |
| `enforcement.validators`, when present | who enforces on chain |

| Dropped | Why |
|---|---|
| `id`, `owner`, `signature` | identify the end-user |
| `name`, `description` | free text; unique per end-user |
| `created`, `updated` | instants; unique per end-user |
| each rule's `id` | a label the end-user chose |
| `enforcement.smart_contract`, `enforcement.dispute_resolution` | an address and free text of the end-user's own |

The terms are produced by allowlist, never by removal: a field added to the
schema later is excluded until this document says it is contractual.

## Export

`exportTerms(policy)` (identity package) and `export_terms(policy)` (agent)
produce the same bytes from the same policy:

1. Take `version`.
2. For each rule, take `context_scope` and its conditions, the conditions
   themselves by allowlist: `identity` (`type`, `linkage`; a `linkage`
   object keeps `ephemeral_required`, `proof_of_root_allowed`,
   `zk_continuity_allowed`), `proofs` (each `type`, `claim`, `params`),
   `retention` (`max_seconds`, `audit_log`), `derivatives` (`training`,
   `aggregation`, `resale`), `payment` (`protocol`, `amount`, `currency`),
   and from S-PAL 1.1 `custody` (`operator`, `hosted_models`,
   `attestation_required`), which says whose machine may work on the data.
   A condition or field this list does not name is not part of the terms
   until this document says it is; `proofs[].params` is the one free-form
   field, because what a proof must show is the contract. Drop the rule's
   `id` and anything else on the rule.
3. Sort the rules by `context_scope`, then by the RFC 8785 canonical JSON of
   the reduced rule. Text compares by UTF-16 code units, the order RFC 8785
   gives object keys and the order JavaScript's `<` gives strings; a Python
   implementation compares `text.encode("utf-16-be")`, not code points. The
   order an end-user wrote rules in is not part of the terms.
4. If `enforcement.validators` is present and non-empty, take it sorted the
   same way; otherwise emit no `enforcement`. A validator that is not text,
   a rule that is not an object, a `context_scope` that is not text, or
   `conditions` that are not an object: the policy has no terms, and export
   fails rather than producing partial terms.
5. Emit the result as RFC 8785 canonical JSON: keys sorted by UTF-16 code
   units, no insignificant whitespace, ECMAScript number and string forms.
   The integer fields (`retention.max_seconds`, `payment.amount`) are
   non-negative integers no larger than 2^53 - 1, the largest value every
   implementation holds exactly; a policy carrying anything else there
   (larger, negative, a float, text, a boolean) has no terms, and every
   implementation refuses it rather than hashing a value another could not
   reproduce.

A policy without `version` or `rules` has no terms; export fails rather than
producing partial terms.

Two rules on one `context_scope` both appear in the terms, sorted. The
agent evaluates the first in that same order, not the order the end-user
wrote them in, so two policies with the same terms make the same decision;
an end-user who wants a business to see one rule per scope writes one.

## Terms hash

The terms hash is the SHA-256 of the UTF-8 bytes of the canonical JSON from
step 5, written as 64 lowercase hex characters.

## Exchange

1. The end-user's agent creates a service request naming one of the end-user's
   policies by name. The agent reads the policy from the end-user's vault and
   attaches the terms, the terms hash, and the policy's name and description
   as labels. The business reads them.
2. The business sends a verification request carrying the terms hash it
   accepts. The agent resolves the hash to a stored policy by hashing each of
   the end-user's policies' terms; no match is a denial.
3. The agent evaluates the request against that policy. Sending the hash is
   accepting every condition in the terms; the agent then checks what the
   request itself can show (the identity it comes under, the proof it will
   receive), treats retention and derivatives as accepted unless the
   request states an offer that breaks them, read as the next section reads
   a rule that is silent on either, and treats a payment
   condition as a precondition: it must have been met, not merely accepted,
   before anything is released. The stored response the business reads
   echoes the terms hash.
4. The authorization record the end-user's app writes for the ephemeral DID
   carries the terms hash as `policyHash`, so the end-user's own evidence of
   each verification records which terms were in force.

Until a policy registry exists (#16), the service request is the carrier of
terms. When the registry carries them instead, the hash and the echo stay.

## What a rule does not say

A rule permits what it states and nothing else. This holds for whoever the
terms bind, a business asking for the data or an operator working on it:

- a rule with no `retention`, or a `retention` with no `max_seconds`,
  permits no retention: `max_seconds` reads as `0`;
- a rule with no `derivatives` forbids training, aggregation and resale, and
  a `derivatives` that leaves one of the three out forbids that one.

So a request that states it will keep the data for any time, or use it for
training, aggregation or resale, is denied under a rule that is silent on
that point. Nobody gains from a condition the end-user left out, and an end-user
writes down only what they allow, not everything they refuse. The same
reading is why a rule silent on `custody` keeps data on hardware the end-user
owns.

The terms and their hash are unchanged by this. Export does not fill in
what a rule leaves out, so the hash of existing terms stays what it was;
what changes is how every reader evaluates a silent rule.

## Who is asking

A rule's `identity`, `proofs`, `derivatives`, `retention` and `payment`
conditions are about a third party that wants the data. The end-user asking
their own agent about their own data is not that party, so for the end-user
those conditions are satisfied by definition and are not evaluated. The
rule must still exist and match the scope: no rule, no answer.

The `custody` condition (S-PAL 1.1, #42) is about whose machine the end-user's
own agent may send the data to, so it binds the end-user's asks as well as
third-party requests. It is the first condition that does.

## Linkability

Two end-users with identical rules produce identical terms and the same hash;
standard rule sets converge, and a business learns nothing about an end-user
from a hash many end-users share. A bespoke rule set is as linkable across
businesses as any bespoke contract text would be. This is the trade-off
chosen: terms recognizable across end-users rather than hashes that are
unlinkable but opaque. If unlinkability of bespoke terms is ever needed, a
per-request nonce mixed into the hash is the remedy, and the business then
keeps the nonce with the terms.

## Relation to `spal/commit/v1`

The on-chain commitment's `content_hash` is computed over the on-chain
policy datum, a reduced single-rule structure that contracts own (see
`preimage-encoding.md`, structure 1). It is not a hash of these terms, and
these terms are not a redefinition of it. Aligning the two, so that end-user,
business and chain refer to one fingerprint, is tracked on #16 (the datum
carries the terms hash). Until then, the terms hash is the off-chain
reference for "which terms did you accept" and nothing more.

## Accountability

The terms hash on a business's request says which terms it accepted, but
the request is not yet signed by the business, so the end-user's record of the
acceptance is the end-user's own. Signing it in the DID envelope
(`spal/did-envelope/v1`) is #136.

## Test vectors

`spec/schemas/spal/v1.0/terms-vectors.json` holds, for each vector, the
policy, the canonical JSON of its terms, and the terms hash. The identity
package and the agent both reproduce every vector byte for byte. The
`unsorted-rules-with-handles` vector exercises rule sorting (two rules on
one scope, listed out of order), the dropped handles, and validator sorting;
`utf16-order` pins the UTF-16 order with a non-BMP scope sorting before a
high-BMP one.
