# ADR-009: An atproto Account as a Freehold Root Identity

**Status:** Proposed
**Date:** 2026-11-04
**Decision:** A Freehold root identity may be an atproto account (`did:plc` or `did:web`) in addition to a locally generated `did:key`. The root key stays a Freehold-held Ed25519 key; the account binds itself to that key by publishing it as an `earth.freehold.rootKey` record in its own atproto repository, and verifiers of authorization records resolve that binding. `did:key` remains the default and is unchanged. This is not a Freehold DID method and does not displace the Passport / `did:midnight` plan of ADR-008.

## Context

Freehold's root identity has been a locally generated `did:key` since the identity package existed. Ephemeral DIDs are linked to it by an authorization record the root signs over the `spal/did-authorization` preimage, and `verifyAuthorizationRecord` recovers the root's public key from the `did:key` identifier itself. The ephemeral layer and the authorization-record model are the subject of the [identity privacy model](../concepts/identity-privacy-model.md) and are not changed here.

Shared Computer Network (Z-Space, Vancouver) runs an OpenAI-compatible inference endpoint behind an OAuth session broker whose members sign in with atproto accounts (`did:plc`). To demonstrate the agent on that node's hardware, its members should get Freehold ephemeral identities without a second login. [The atproto analysis](../concepts/at-protocol-analysis.md) of December 2025 concluded "no action needed"; this is the one action that was worth taking. S-PAL already accepts any standard DID method for policy owners (#56), so without this the identity layer could verify fewer roots than policies could name.

The constraint that shapes everything: an atproto account holder does not normally hold a private key. The repository signing key lives on the PDS, and the PLC rotation keys usually do too. Nothing on the account's side can sign a Freehold authorization record.

## Decision

1. **Binding, not key sharing.** The root key is a Freehold-held Ed25519 keypair, generated and stored exactly as a `did:key` root's is. The account publishes the public key, as a did:key-style multibase string with a `createdAt` and optional `expiresAt`, in a singleton record (`rkey` `self`) under the `earth.freehold.rootKey` lexicon. The PDS commits the record on the holder's behalf, so its presence in the signed repository is the holder's authorisation of that key. Deleting or replacing it revokes the binding.

2. **The signed structure names the binding.** `spal/did-authorization/v2` appends `root_key_id`, the CID of the binding record the signer's key was published under, empty for a `did:key` root. A record issued under an earlier binding can then be checked against the key that was current when it was issued, by a verifier that chooses to allow historical keys. `v1` is retired; it shipped in freehold-preimage 0.3.0 and identity 0.3.0, so records signed by those releases no longer verify. There is no production data behind them.

3. **Verification resolves, through an injectable resolver.** For a root that is not a `did:key`, verification resolves the DID document (plc.directory for `did:plc`, the well-known document for `did:web`), takes the PDS it names, fetches the binding record over the public `getRecord` endpoint, checks the binding is in force, and verifies the signature with the published key. Every step is replaceable: a DID resolver, a record fetcher, or the whole root key resolver can be injected, so tests and offline use never touch the network. Historical keys are opt-in, documented as trusting the record's own timestamp, and in practice need a resolver with its own store of past bindings, because a PDS serves only the current version of a record.

4. **No atproto dependency.** The identity package gains none. The OAuth session that writes the binding is typed structurally as the account DID plus a credentialed `fetchHandler(pathname, init)`, which is the shape `@atproto/oauth-client` returns, and the writes are plain XRPC calls (`putRecord`, `deleteRecord`) over `fetch`. Verification needs only `fetch`. Writing needs the `repo:earth.freehold.rootKey` permission.

5. **Flat lexicon namespace.** The NSID is `earth.freehold.rootKey`, with authority `freehold.earth`, so one DNS TXT record at `_lexicon.freehold.earth` and one repository can publish it and every future `earth.freehold.<name>` lexicon. Publishing the lexicon is deferred: a PDS stores records in an unknown collection and the verifier interprets the record itself, so nothing depends on it until third-party tooling or strict validation does. The schema is kept in `spec/schemas/lexicons/` and a test holds the record the package writes to it.

6. **Resolution does not follow a DID document anywhere.** The document is data the account controls. Resolution accepts only `https` PDS origins with no path, refuses localhost, `.localhost` and IP-literal hosts (as the URL parser canonicalises them) and plain `http`, does not follow redirects, and bounds each response in time and size, unless an explicit `allowLocal` flag is set for development against a local PDS. Private DNS names cannot be told apart at this layer; a deployment on a network with sensitive internal services should resolve through an egress proxy or an injected resolver.

7. **Deferred.** Mirroring the binding into the DID document as a `verificationMethod` (a PLC operation, so a rotation key) for verifiers that will not fetch repository records; verifying the repository's commit proof against the account's atproto signing key rather than trusting the PDS; sign-in and broker integration, which are the node's concern. Each is picked up when a verifier or a node asks for it.

## Rationale

**Why binding rather than key sharing.** Asking the PDS for the repository signing key, or holding a PLC rotation key in the agent, would put the Freehold root's security in the hands of the PDS operator and would stop working the moment the account moved. A Freehold-held key with a public binding keeps the key where every other root key lives, and uses the one thing an atproto account can reliably do: commit a record to its own repository.

**Why this is not a Freehold DID method.** ADR-008 decision item 6 says not to build one, and nothing here does. The DIDs are `did:plc` and `did:web` as atproto defines them; Freehold adds one record type to a repository. The identity remains portable with the account, and a verifier needs no Freehold-specific resolution beyond reading a record.

**Why `did:key` stays the default.** It costs nothing and exposes nothing: a `did:key` root is never shown to a verifier. An atproto root trades a little privacy (the binding is public and a disclosed record names a social identity) for not needing a second credential, which is the right trade only where someone already has the account.

**Why the structure bump is acceptable.** `root_key_id` has to be under the signature, or a record could be re-pointed at a different binding after signing. A new field under the signature is a new registry entry by the rule in the preimage spec. The retired entry never carried real users' records.

## Alternatives Considered

### Derive the Freehold root from the account's own keys

Rejected: the account holder does not hold them. See "binding, not key sharing".

### Put the binding in the DID document instead of a repository record

Would let a verifier stop after resolving the DID document. Rejected for now: it needs a PLC operation signed by a rotation key, which most account holders cannot produce, and `did:web` documents are served by whoever runs the host. Recorded as a possible addition for verifiers that will not read repository records.

### Depend on `@atproto/api`

Would give typed clients for the two XRPC calls. Rejected: the identity package has two dependencies and both are cryptography; the calls are two JSON POSTs; verification must not need the package; and the session shape the OAuth client exposes already fits a two-member structural type. Nothing is lost that a caller with an `Agent` cannot pass as `{ did, fetchHandler }`.

### Keep verifying `v1` records that carry no `rootKeyId`

Would spare identity 0.3.0 users a re-issue. Rejected: it makes the verifier accept two encodings of one record type, which the preimage spec's registry rule exists to prevent, for the benefit of records nobody has issued in production.

### Grouped lexicon namespace (`earth.freehold.identity.rootKey`)

Mirrors Bluesky's convention and the repository's package layout, at the cost of one DNS record per group. The decision is per lexicon and reversible by migration, so flat was chosen for the first and most permanent record type, with grouped names still open to future lexicons that want their own authority.

## Consequences

### Positive

- A node that signs people in with atproto can hand them Freehold identities with no second credential, which is what the Shared Computer Network demonstration needs.
- The identity layer verifies `did:key`, `did:plc` and `did:web` roots. Other standard methods that S-PAL policies can name as owners, such as `did:midnight`, are still not verified until a verifier for them exists.
- The ephemeral layer, the authorization-record model, and the `did:key` path are untouched.
- No new dependency; verification works offline with an injected resolver.

### Negative

- `spal/did-authorization/v2` is a breaking change for identity and freehold-preimage; both need a release and their consumers a re-issue of any stored records.
- An atproto root is less private than a `did:key` root in the two ways the privacy model now states.
- A verifier trusts the PDS until commit-proof verification is added.
- Historical keys, where enabled, rely on the signer's timestamp, and work only with a resolver that stored past bindings itself.

### Neutral

- The lexicon exists as a file but is not yet published under `_lexicon.freehold.earth`; that is an operations step for whenever a third party needs it.
- Sign-in, the OAuth broker, and S-PAL identity conditions are unchanged and out of scope.

## References

- [ADR-008: Positioning Relative to Midnight Nightframes and Passport](008-positioning-nightframes-passport.md) — decision items 2 (identity path) and 6 (no Freehold DID method), both respected here
- [ADR-007: Cardano ↔ Midnight Interop Path](007-cardano-midnight-interop-path.md) — the encoding rules the structure bump follows
- [Identity Privacy Model](../concepts/identity-privacy-model.md) — "External roots"
- [AT Protocol Analysis](../concepts/at-protocol-analysis.md) — the recommendation this actions
- [Preimage encoding spec](../../spec/protocols/preimage-encoding.md) — `spal/did-authorization/v2`
- [atproto DIDs](https://atproto.com/specs/did), [Lexicon](https://atproto.com/specs/lexicon), [record keys](https://atproto.com/specs/record-key), [permissions](https://atproto.com/specs/permission)
- freehold#92 (this decision), #56 (any DID method as S-PAL owner), #30 (records signed over the authorization preimage)
