# Policy Terms

Status: adopted 2026-11-07 (design: `docs/superpowers/specs/2026-11-07-policies-in-the-context-store-design.md`, #134).

## Purpose

A business that asks a holder to prove something is asking under the
holder's S-PAL policy. The business must be able to see what it is agreeing
to, and both sides must later be able to show which terms were in force,
without the business learning who the holder is.

A policy's id is `spal:{owner DID}:{name}`. The owner is the holder's root
DID, which the identity privacy model keeps from every third party. So the
id never travels to a business. What travels is the policy's **terms**, and
what the business echoes back is a hash of them.

## Terms

The terms of a policy are its contractual content and nothing else:

| Kept | Why |
|---|---|
| `version` | which S-PAL the rules are written in |
| each rule's `context_scope` and `conditions` | what is governed and how |
| `enforcement.validators`, when present | who enforces on chain |

| Dropped | Why |
|---|---|
| `id`, `owner`, `signature` | identify the holder |
| `name`, `description` | free text; unique per holder |
| `created`, `updated` | instants; unique per holder |
| each rule's `id` | a holder-chosen label |
| `enforcement.smart_contract`, `enforcement.dispute_resolution` | a per-holder address and free text |

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
   `aggregation`, `resale`), `payment` (`protocol`, `amount`, `currency`).
   A condition or field this list does not name is not part of the terms
   until this document says it is; `proofs[].params` is the one free-form
   field, because what a proof must show is the contract. Drop the rule's
   `id` and anything else on the rule.
3. Sort the rules by `context_scope`, then by the RFC 8785 canonical JSON of
   the reduced rule. Text compares by UTF-16 code units, the order RFC 8785
   gives object keys and the order JavaScript's `<` gives strings; a Python
   implementation compares `text.encode("utf-16-be")`, not code points. The
   order a holder wrote rules in is not part of the terms.
4. If `enforcement.validators` is present and non-empty, take it sorted the
   same way; otherwise emit no `enforcement`. A validator that is not text,
   a rule that is not an object, a `context_scope` that is not text, or
   `conditions` that are not an object: the policy has no terms, and export
   fails rather than producing partial terms.
5. Emit the result as RFC 8785 canonical JSON: keys sorted by UTF-16 code
   units, no insignificant whitespace, ECMAScript number and string forms.

A policy without `version` or `rules` has no terms; export fails rather than
producing partial terms.

## Terms hash

The terms hash is the SHA-256 of the UTF-8 bytes of the canonical JSON from
step 5, written as 64 lowercase hex characters.

## Exchange

1. The holder's agent creates a service request naming one of the holder's
   policies by name. The agent reads the policy from the holder's vault and
   attaches the terms, the terms hash, and the policy's name and description
   as labels. The business reads them.
2. The business sends a verification request carrying the terms hash it
   accepts. The agent resolves the hash to a stored policy by hashing each of
   the holder's policies' terms; no match is a denial.
3. The agent evaluates the request against that policy. The stored response
   the business reads echoes the terms hash.
4. The authorization record the holder's app writes for the ephemeral DID
   carries the terms hash as `policyHash`, so the holder's own evidence of
   each verification records which terms were in force.

Until a policy registry exists (#16), the service request is the carrier of
terms. When the registry carries them instead, the hash and the echo stay.

## Who is asking

A rule's `identity`, `proofs`, `derivatives`, `retention` and `payment`
conditions are about a third party that wants the data. The holder asking
their own agent about their own data is not that party, so for the holder
those conditions are satisfied by definition and are not evaluated. The
rule must still exist and match the scope: no rule, no answer.

The compute-locality condition `processing` (S-PAL 1.1, #42) is about where
the holder's own agent may send the data, so it binds the holder's asks as
well as third-party requests. It is the first condition that does.

## Linkability

Two holders with identical rules produce identical terms and the same hash;
standard rule sets converge, and a business learns nothing about a holder
from a hash many holders share. A bespoke rule set is as linkable across
businesses as any bespoke contract text would be. This is the trade-off
chosen: terms recognizable across holders rather than hashes that are
unlinkable but opaque. If unlinkability of bespoke terms is ever needed, a
per-request nonce mixed into the hash is the remedy, and the business then
keeps the nonce with the terms.

## Relation to `spal/commit/v1`

The on-chain commitment's `content_hash` is computed over the on-chain
policy datum, a reduced single-rule structure that contracts own (see
`preimage-encoding.md`, structure 1). It is not a hash of these terms, and
these terms are not a redefinition of it. Aligning the two, so that holder,
business and chain refer to one fingerprint, is tracked on #16 (the datum
carries the terms hash). Until then, the terms hash is the off-chain
reference for "which terms did you accept" and nothing more.

## Accountability

The terms hash on a business's request says which terms it accepted, but
the request is not yet signed by the business, so the holder's record of the
acceptance is the holder's own. Signing it in the DID envelope
(`spal/did-envelope/v1`) is #136.

## Test vectors

`spec/schemas/spal/v1.0/terms-vectors.json` holds, for each vector, the
policy, the canonical JSON of its terms, and the terms hash. The identity
package and the agent both reproduce every vector byte for byte. The
`unsorted-rules-with-handles` vector exercises rule sorting (two rules on
one scope, listed out of order), the dropped handles, and validator sorting;
`utf16-order` pins the UTF-16 order with a non-BMP scope sorting before a
high-BMP one.
