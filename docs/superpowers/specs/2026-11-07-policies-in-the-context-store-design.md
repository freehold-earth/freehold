# Policies live in the context store

Date: 2026-11-07. Status: approved by the user 2026-11-07, with the export rule in section 2.

## Intent

The agent is the enforcer of the holder's S-PAL policies, and today it has
nothing to enforce. The approval service builds a fresh, empty
`PolicyChecker` for every request; no code path, setting, or endpoint ever
loads a policy into it. The demo's business app sends no policy on its
requests, so every autonomous approval is denied before a policy is even
looked for, and the demo compose runs in manual mode, whose approve button
never consults a policy at all. "The policy decided" is not yet true
anywhere in the running system.

This design makes it true. A policy is the holder's own data and lives in
the context store, encrypted by the holder's client, readable by the agent
only after the vault is unlocked. The holder's terms travel to the business
without the holder's identity, the business echoes the terms it accepted,
and the agent evaluates every decision, autonomous or by button, against the
holder's stored policy. A new route lets the holder ask their agent about
their own data under a policy, which is the path the compute-locality
condition (#42) and the outbound audit (#93) will govern.

The demo was built when the project started. Where it disagrees with the
spec or the privacy model, the demo changes, not the design.

## Why the context store, and why not files

The alternative was a directory of policy JSON files named by a setting and
read at agent startup. It was rejected (user decision, 2026-11-07) as tech
debt from day one: a second place where holder data lives, unencrypted,
outside sync, and a pattern later work would read as settled. The context
store is also what the spec assumes. The on-chain commitment
(`spal/commit/v1`) binds a policy id, owner and content hash; the document
itself was always meant to stay with the holder.

There is no circularity. The policy is read under the vault unlock like
every other entry, and the approval flow already refuses while locked. The
precedent is the authorization records of #106, holder evidence kept under
`identity/authorizations/<id>` and never governed by a rule.

## Goals

- A policy the holder has written into their context store is what the
  agent evaluates, with no restart and no agent-side configuration.
- A business never learns the holder's root DID, and gains no stable handle
  on the holder beyond the terms themselves. It receives the policy's terms
  and echoes a hash of them; the policy id and owner never leave the
  holder's side.
- Both decision paths, autonomous and by button, consult the policy. The
  button approves within the holder's standing rule, not around it.
- A request naming terms that are absent, malformed, or not the holder's is
  denied. The specific reason is logged and shown to the holder; the business
  sees one generic reason.
- The holder can ask their agent a question about their own data under one
  of their policies, through the API, from the user app. That route can
  never read identity material, whatever the policy says.
- The demo's user app seeds one spec-shaped policy on first unlock and shows
  it in its Policies tab from the store.

## Non-goals

- A policy editor in the user app. Seeding and display only.
- Publishing or discovering policies as a registry (#16). Until then the
  holder's service request carries the terms.
- Anchoring a policy's commitment on chain (#16), multi-device sync (#11),
  the `processing` condition (#42), named operators, and the audit line
  (#93). The ask route is where those land next; this design gives them a
  caller.
- Configuring a model backend in the demo compose (#70). The ask route
  reports plainly when none is configured.
- Agent-issued ephemeral DIDs for the autonomous path. The agent must not
  hold the root private key, so it cannot issue one; see section 5 for what
  that means for policies that require ephemeral identity.
- Authentication on the API (Phase 2). The demo's two apps share one
  unauthenticated, loopback-bound API; what the business can see of a stored
  response is bounded by this design, not by auth.

## Anti-goals

- A cache that lets a stale policy decide. The holder's edit is the next
  request's policy.
- Any result that reads "allowed" without a policy that matched a rule, on
  any path. The "policy not found, defaulting to allow" result is removed,
  and the ask path denies on "no rule governs this scope" too.
- A root DID on the wire to a business, in a key, in a stored response, or
  in a prompt to a model. The store sees keys unencrypted and may sync them;
  the authorizations precedent keeps DIDs inside values and policy keys do
  the same.
- A second policy format. The store holds spec-shaped S-PAL JSON, the same
  document the agent's models validate and the spec's examples use. The user
  app's camelCase `SPALPolicy` type is replaced, not mapped.
- An ask that reaches the model with no policy, or with identity material in
  scope.
- A request context that asserts something the flow did not do. The
  deterministic builder states only what is true of that request.

## Constraints

- The store is a per-user map of key to encrypted blob. Values are encrypted
  by the client with the vault password; keys are plaintext. The agent
  decrypts entries after `POST /unlock` hands it the password, using the
  vault format the user app writes. An entry the password cannot open is
  reported by the client as absent, with a warning in the log; such a policy
  reads as "not found".
- The agent's context client reads by scope, where a scope's domain is its
  first path segment, and reads a single entry by key. A key equal to its
  own domain, such as `root-identity`, is in that domain. Claim reads stay
  confined to the claim's scope from `CLAIM_INPUTS`.
- The agent already reads the `root-identity` entry's public fields (`did`,
  `publicKey`) to verify authorization records. It never needs the private
  key and must not use it or forward the entry anywhere.
- Decrypting an entry is PBKDF2 work. One policy read per decision is one
  such operation. Acceptable; noted so the builder does not add a cache.
- No new environment variable. A new value for an existing one is fine.
- Policy ids are `spal:{owner DID}:{name}` and the embedded DID must equal
  `owner` (#81). The schema cannot check that; the agent must.
- The on-chain `PolicyDatum` (contracts) is a reduced, single-rule form that
  includes the owner and is hashed as PlutusData CBOR for `spal/commit/v1`.
  It is not the document a business reads, so the terms hash below is a
  separate, named artifact, not a redefinition of the commitment.
- The autonomous path issues no DID: an autonomous proof names no requester
  and the business receives `requester_did: null` (#107). Only the button
  path has an ephemeral DID, issued by the user app.
- Today the approval service stores the checker's reason verbatim on the
  response, which both apps read through `GET /requests`.
- `Agent.process` today answers without context when the vault is locked,
  reads by lexical search rather than by scope, builds its own context
  client, and proceeds on any allowed result including "no rules govern
  scope". It is the only model-with-context code and is reshaped below
  rather than duplicated.

## Design

### 1. Storage

A policy with id `spal:{owner}:{name}` is stored under the key
`policies/{name}`. The owner DID stays inside the encrypted value.

The `policies` domain is distinct from `personal` and `identity`, so a
claim read never touches policies and a policy read never touches claim
data or identity records. A name is any text without a colon or control
character; the store treats keys as opaque strings and both clients
percent-encode, so a name containing `/` or `.` is a legal, literal key and
nothing more.

One holder, one store, so a name identifies a policy without the DID.

### 2. Terms and the terms hash

The **terms** of a policy are its normative content: `version`, the
rules' scopes and conditions, and which validators enforce it. Not `id`,
`owner` or `signature`, which identify the holder; not `name`,
`description`, `created` or `updated`, which are free text and instants
that would make every holder's terms unique; and not rule ids or contract
addresses, which are handles too. A business is shown the terms, and may be shown the name and
description beside them as labels; it agrees to the terms.

**One export function produces the terms** (user decision, 2026-11-07),
implemented once in TypeScript (identity package, beside `canonicalJson`)
and once in Python (agent), with shared test vectors in the protocol
document so the two agree byte for byte. It works by allowlist, never by
removal, so a field added to the schema later is excluded until someone
decides it is contractual. It also fixes the shape so that nothing about
how a holder wrote the policy survives into the terms:

- rules are reduced to `context_scope` and `conditions`; the rule `id` is a
  holder-chosen label and is dropped;
- rules are sorted by `context_scope`, then by their canonical JSON, so the
  order the holder wrote them in is not a fingerprint;
- `enforcement` is reduced to `validators`, sorted; `smart_contract` is a
  per-holder address and `dispute_resolution` is free text, so both are
  handles and are dropped;
- the result is RFC 8785 canonical JSON, which fixes key order and number
  and string forms.

The **terms hash** is SHA-256 over that canonical JSON, hex-encoded. Both
sides already have canonical JSON (`identity/src/preimage.ts`,
`agent/.../authorization.py`). Terms, export and hash are specified in a
short new protocol document, `spec/protocols/policy-terms.md`, as the
off-chain "which terms did you accept" reference, distinct from
`spal/commit/v1`.

The hash identifies terms, not a holder: two holders with the same rules
produce the same hash, and standard rule sets converge. A bespoke rule set
is as linkable as any bespoke contract text would be; the protocol document
says so, and notes that a per-request nonce in the hash is the remedy if it
is ever needed. This is the trade-off chosen here: terms that are
recognizable across holders, rather than hashes that are unlinkable but
opaque.

The authorization record's existing optional `policyHash` field carries the
terms hash from now on, so the holder's own evidence of each ephemeral DID
records which terms were in force. The demo currently puts the policy id in
that record's metadata; that stops, since the id holds the root DID.

### 2a. Accountability: how a holder holds a business to its terms

The point of terms is that a holder can later show a business agreed to
them. The evidence, and where each piece stands:

| Evidence | Holder has it | Business has it | Status |
|---|---|---|---|
| The terms T and their hash h(T) | stored policy, export | the service request it read | this design |
| The business accepted h(T) | its `POST /requests` payload, stored by the holder's agent | its own request | this design, **unsigned** |
| The answer went out under h(T) | authorization record `policyHash`; stored response | stored response echo | this design |
| The chain bound the proof to the policy | `spal/pubin/v2` public input, `policy_content_hash` | same, public | contracts; **binds the wrong thing today** |

Two gaps, stated so they are not mistaken for settled:

**The acceptance is not yet non-repudiable.** The business's request carries
h(T) but is not signed by the business's DID, so the holder's record of it
is the holder's own word. The DID-signed envelope (`spal/did-envelope/v1`,
`agent/.../envelope.py`) exists for agent-to-agent requests and already has
a "related policy" field; carrying h(T) there and requiring the business to
sign its verification request is the fix. It is a follow-up with its own
issue, filed with this design, because it changes how a business talks to
every agent and the demo's business app has no DID today.

**The on-chain commitment binds a stale shape.** `PolicyDatum` in the Aiken
validator is `owner, min_payment, max_retention_ms, identity_linkage,
required_proof_hash, context_scope, payment_currency`: a single rule in the
shape of the original demo app's policy type, not the S-PAL document.
`policy_content_hash` is the Blake2b-256 of that datum, and the ZK public
input binds it. So the fingerprint a business keeps, h(T), and the one the
chain binds are two numbers of two different things, and nothing ties them.
The resolution, for #16 (the policy minting validator) and the preimage
spec, is that the datum carries `terms_hash` as a field, so
`policy_content_hash` commits to h(T), and the datum's structured fields,
which the validator needs to enforce payment and proof on chain, are a
projection of one rule of T that an off-chain reproducer can check against
T. Then holder, business and chain refer to one fingerprint. The datum
change and the `owner` field's privacy (a root DID in a datum is public)
belong to #16 and are commented there (2026-11-07); this design does not touch the
contracts, and says so in `policy-terms.md` so no one reads h(T) as the
on-chain commitment.

### 3. How terms reach the business and come back

Today the business's `POST /requests` carries `policy_id`, which would hand
the business the root DID. That field is removed from the business-facing
API.

- `CreateServiceRequest` (holder to business, through the agent) gains
  `policy_name`. The agent reads `policies/{policy_name}` from the unlocked
  vault, checks it (section 4), and stores on the `ServiceRequest` the
  terms, the name and description as labels, and the terms hash. The
  business lists service requests and sees them. A service request naming a
  policy that is absent or invalid is refused at creation with the
  holder-facing reason; the vault must be unlocked to create one.
- `CreateVerificationRequest` (business to holder) replaces `policy_id` with
  `terms_hash`: the terms the business accepts. It is required. A request
  without one is denied with the existing "no policy configured" reason.
  The direct flow, a verification request with no service request, stays
  valid at the API: a business may send a terms hash it learned from an
  earlier service request or, later, the registry. Only the demo's business
  app loses its direct mode, because the demo has no other source of terms;
  the `VITE_ENABLE_SERVICE_FLOW` flag goes and the service flow is the demo.
- The agent resolves `terms_hash` by listing `policies/` and hashing each
  policy's terms. A holder has a handful of policies; this is a few PBKDF2
  operations per decision and is acceptable. No match: deny, "terms do not
  match any policy". A match gives the policy to evaluate.
- The stored response the business reads echoes the `terms_hash` it sent,
  and the authorization record the user app writes for the ephemeral DID
  carries it as `policyHash`. Both parties then hold the terms and the hash:
  the business can later show what it agreed to, the holder what was in
  force.

This is the registry's shape before there is a registry. When #16 lands,
the registry becomes the carrier of terms and the service request stops
carrying them; the terms hash and the echo stay.

### 4. Reading and checking a policy

`PolicyChecker` is constructed with a `ContextReader` and the holder's root
DID source (the same read of `root-identity`'s public fields the
authorization code does) instead of an in-memory dictionary. Given a policy
entry, before evaluation:

1. Validate with `SPALPolicy.model_validate`. Failure: deny, "policy is not
   valid", with the pydantic path in the holder-side log (#133 made that
   path name the field).
2. Require `id` to equal `spal:{owner}:{name}` where `name` is the key's
   name segment and `owner` is the document's `owner`. Mismatch: deny,
   "policy is not the one named". This closes #81 for the agent.
3. Require `owner` to equal the holder's root DID. Mismatch: deny, "policy
   is not the holder's". A vault whose root identity cannot be read reports
   the existing unavailable outcome.
4. Evaluate.

`ContextUnavailable` during any read is raised unchanged, so the approval
service reports its existing "private data unavailable" outcome and logs the
cause. No cache.

**Who is asking.** Conditions in a rule fall into two kinds. `identity`,
`proofs`, `derivatives`, `retention` and `payment` are about a third party
that wants the data. `processing` (#42, not in this design) is about where
the holder's own agent may send the data, and binds the holder's asks too.
The checker takes a `requester` of `third_party` or `holder`. For the
holder, the third-party conditions are satisfied by definition and are not
evaluated; the rule still has to exist and match the scope. This is stated
in `policy-terms.md` and the README, so that when `processing` lands it is
the first condition the holder's own asks are measured against.

The in-memory `load_policy` and `list_policies` go. Tests write policies
into a fake `ContextReader`; there is no shared double today (`test_seams`
has an entries-only one), so one is added under `agent/tests/`.

### 5. Both decision paths consult the policy

The request context the deterministic builder hands the checker states what
is true of the request and nothing more:

- `identity`: the ephemeral DID the user app issued, when the request has
  one; absent otherwise. The autonomous path has none, so a rule that
  requires an ephemeral identity denies an autonomous approval. That is the
  correct reading of the rule, not a gap to paper over: a holder who requires
  an ephemeral identity has asked for the path where their app issues one.
  The agent cannot issue DIDs itself without the root key, which it must not
  hold. Policies that do not require identity approve autonomously.
- `proofs`: the claim's proof, `[{"type": "zkp", "claim": <claim type>}]`,
  since the service generates it on approval.
- Intended use, retention and payment: unset. The flow makes no offer about
  them and the business makes none.

The seams docstring that called a populated context Phase 2 is updated to
describe this.

The paths:

- Autonomous (`ApprovalService.decide`): already consults the policy; now
  with the context above and the terms-hash lookup.
- Button (`POST /requests/{id}/approve`): evaluates the same policy the same
  way before generating the proof, with the ephemeral DID the user app
  issued in the context. A human cannot approve what the holder's standing
  rule forbids; the button is consent within the rule.

The demo compose stays in manual mode. The demo's story is the button: the
holder is asked, the policy is checked, the answer goes out under an
ephemeral DID, or the policy refuses and the holder sees why. Autonomous
modes behave as above and are documented, not demonstrated.

**Reasons.** A denial by policy stores one generic reason on the response,
"not permitted by the holder's policy", which is what the business reads.
The specific reason (which check failed, which rule) is logged on the
holder's side and returned in the `/approve` HTTP body, which only the
holder's app calls. `ApprovalDecision` carries both; `_response` stores the
generic one.

### 6. The ask route

`POST /ask` with `{"question", "policy_name", "context_scope"}`, for the
holder's own app:

- Requires the vault unlocked; otherwise the existing locked status. A
  locked or unreachable store is an error here, never "answer without
  context".
- Refuses, before any policy is read, a `context_scope` in the `identity`
  domain or equal to `root-identity`, and any key in those domains, whatever
  the policy says. Identity material never goes to a model.
- Reads `policies/{policy_name}`, checks it as in section 4 with
  `requester=holder`, and requires a rule that matches `context_scope`. No
  matching rule: deny, with the policy name. A rule that forbids: deny with
  the rule id.
- Reads the scope's entries (not a lexical search), builds the prompt, and
  calls the model. The response carries the answer, the rule id applied,
  and which entries informed it.
- With no model backend configured, returns a plain "no model backend
  configured" status. `FREEHOLD_LLM_BACKEND` gains the value `none` for that
  state; today the default is `http` at a local URL, which in the demo fails
  with a connection error that says nothing useful. The demo compose sets
  `none` until #70 points it at a backend.
- Served only to the user app's origin: `/ask` gets its own CORS check
  against the holder-app origin, narrower than the shared allowlist, which
  today includes the business app's origin.

`Agent.process` is reshaped into this, not duplicated: the `Agent` takes the
app's context client (its own `unlock`/`lock` go), raises on an unavailable
store, reads entries by scope, and denies unless a rule matched.
`test_agent.py` follows; the two tests that assert "locked means no
context, not an error" invert.

This is the model-with-context path. It is where `processing` (#42) will be
evaluated against the backend's locality and where the audit line (#93) is
written. Neither is in this design.

### 7. The user app

- `types.ts` takes the spec shape of a policy, mirroring
  `spec/schemas/spal/v1.0/schema.json`; the camelCase policy types go.
  Promoting the type to a shared package waits for a second consumer.
- On unlock, after the root identity is loaded, the app lists `policies/`.
  If none, it seeds `policies/age-verification`: the age-verification policy
  the demo already describes, in spec shape, `owner` the root DID, `id`
  `spal:{root DID}:age-verification`, one rule on `personal/age` requiring
  an ephemeral identity and a `zkp` proof of claim `age`, forbidding
  derivatives, zero retention.
- The Policies tab renders policies read from the store and shows each
  policy's terms hash.
- Vault reset deletes `policies/*` along with the other entries it deletes
  today, so a seeded policy does not outlive its owner.
- The service request the user app creates names `policy_name`.
- The authorization record's `policyHash` is the terms hash of the policy
  named; the policy id leaves the metadata.
- An Ask box on the context tab: question, policy (from the Policies tab's
  list), scope from the holder's own scopes, never identity.
- The approve flow shows the specific denial reason from the `/approve`
  body when the policy refuses.

### 8. The business app

- Reads the terms and labels off each service request and shows them before
  it asks for a verification; sends `terms_hash` on `POST /requests`; shows
  the echoed hash on the result. No policy id anywhere. The direct mode and
  its flag are removed.

### 9. Documentation

- `spec/protocols/policy-terms.md`: terms, the export function and its
  test vectors, terms hash, the echo, the linkability trade-off, holder versus third-party conditions, and why the
  hash is distinct from the commitment.
- `agent/README.md`: where policies come from, the two decision paths and
  what each asserts, the generic and specific reasons, the ask route and
  what it refuses.
- `demo/README.md`: the seeded policy, its key, the terms flow, the Ask box,
  that the demo runs the button path, `FREEHOLD_LLM_BACKEND=none`.
- Technical appendix: the reference policy moves `payment` under
  `conditions` and marks `persona` as proposed (separate docs commit;
  `persona` gets its own spec issue).

## What is left to the builder

- Exact TypeScript policy type and where the seed lives in the user app.
- Shape of the shared fake `ContextReader`.
- Whether the id and owner rules live as a model validator in `spal.py`
  (next to #81's subject) or in the checker; stated once either way.
- Log line wording, matching the approval service's existing style.
- Request and response model names for the ask route and the terms fields,
  following the existing `Create*` naming.
- How `requester` is passed: a parameter on `check` or two methods.

## Acceptance

- A policy written by the user app under `policies/<name>` is evaluated by
  the agent on the next decision with no restart.
- Invalid, mis-named, and mis-owned policies each deny with their own
  holder-side reason; unmatched terms deny; a locked vault reports the
  existing unavailable outcome; no business-facing payload, stored response
  or label contains a policy id, a DID of the holder, or a free-text or
  timestamp field of the policy inside the hashed terms.
- The demo's age verification approves end to end through the button with
  the seeded policy, and denies when the business sends a terms hash that
  matches no policy. An autonomous approval under the seeded policy denies
  because no ephemeral identity is present; an autonomous approval under a
  policy without an identity condition approves.
- The ask route answers under the seeded policy with a configured backend,
  refuses a scope in the identity domain before reading any policy, refuses
  when no rule matches the scope, and reports "no model backend configured"
  under `none`.
- No `allowed=True` result exists without a matched rule, on either path.
- Agent suite, user-app and business-app checks, and the service-flow test
  cover the above.

## Issues

- #134: this work (policies in the context store, terms exchange, both
  paths consult policy, ask route).
- Closes #81.
- #135: `persona` on rules as a future S-PAL field (spec).
- Comment on #42 and #93: the ask route is their caller and the holder
  requester kind is what `processing` binds.
- Comment on #16: the datum carries `terms_hash`; the structured fields are a
  projection of one rule; the `owner` field's privacy.
- #136: business signs its verification request (DID envelope carrying the
  terms hash), so acceptance is non-repudiable.
