# Canonical Preimage Encoding

Version: 1.0

## Overview

Every signed or committed multi-field preimage in PCI — S-PAL policy
commitments, zero-knowledge public inputs, and DID-signed request envelopes —
MUST use the canonical encoding defined here. The encoding guarantees
**injectivity**: no two distinct field tuples ever serialize to the same bytes.

This requirement comes from [ADR-007](https://github.com/peteski22/pci-docs/blob/main/decisions/007-cardano-midnight-interop-path.md).
Its origin is the 21 July 2026 Wanchain `TreasuryCheck` exploit, in which
fourteen variable-length fields were raw-concatenated with no boundaries, so
distinct field tuples produced identical bytes, identical hashes, and reusable
signatures — re-partitioning an authorization for ~3,110 NIGHT into one for
203M+ with no key compromise.

An encoding is **non-injective** when two different field tuples serialize to
the same bytes. Concatenating variable-length fields without boundaries does
exactly this: `("alice", "bob123")` and `("aliceb", "ob123")` both yield
`alicebob123`. A signature over one authorizes the other.

Two properties are distinct and both required:

- **Domain separation** stops a commitment valid in one context being replayed
  in another. It does nothing about ambiguity *within* a context.
- **Injectivity** stops fields being re-partitioned within a context.

The domain separator is not exempt from injectivity: a variable-length
separator concatenated ahead of unprefixed fields is itself part of the
ambiguity. Under this spec the separator is simply the first length-prefixed
field, so it is covered by the same rule as everything else.

## The Encoding Rule

A preimage is the concatenation, in schema-defined order, of its fields:

1. **Variable-length field** — emitted as a **4-byte big-endian unsigned length
   prefix** followed by the raw field bytes:

   ```
   uint32_be(len(field)) || field
   ```

2. **Fixed-width field** — emitted raw, with no prefix, at the exact width
   pinned by the field's schema:

   ```
   field   // where len(field) == schema-defined width, always
   ```

3. **Domain separator** — the first field of every preimage. It is
   variable-length, so it is length-prefixed like any other variable-length
   field (rule 1).

That is the entire rule. There are no other cases.

### Why fixed-width fields need no prefix

A field whose width is fixed by the schema (a 28- or 32-byte hash, an 8-byte
integer) cannot be re-partitioned against its neighbours, because its boundary
is known from the schema rather than from the byte stream. Fixed-width fields
therefore concatenate injectively without a prefix.

This exemption is **schema-driven, never value-driven**. A field is fixed-width
only if this specification (or a downstream spec that owns it) pins its width.
An implementation MUST emit exactly that width and MUST reject any value of a
different width. "It happens to be 32 bytes this time" is not fixed-width.

### Length-prefix rules (normative)

- The length prefix is a **uint32 big-endian** integer.
- The maximum length of any variable-length field is `2^32 - 1` (4294967295)
  bytes.
- An encoder MUST reject a variable-length field longer than the maximum. It
  MUST NOT wrap, truncate, or otherwise coerce the length — doing so
  reintroduces the ambiguity this encoding exists to remove.
- An empty variable-length field is still emitted with its length prefix
  (`00000000`). Empty is a distinct, valid value; it is not the same as an
  absent field. All fields listed for a structure version are mandatory.

### What this spec does not pin

**Injectivity is a property of the encoding, not of the hash.** This
specification defines the encoding and deliberately does **not** choose a hash
function. ADR-005's reconstruction pattern uses `Blake2b-256`; BlockSec's
analysis of the Wanchain exploit recommends `Sha3_256`. Either preserves the
injectivity established here; switching between them changes nothing about it.
The hash choice belongs with the circuit and contract work, where
field-element widths and on-chain costs decide it, and is owned by the
downstream repositories (pci-contracts, pci-zkp).

## Domain-Separator Registry

The domain separator is a fixed ASCII namespace string with an embedded
version. The registry below is the single source of truth; a repository MUST
use one of these strings verbatim and MUST NOT invent its own.

| Domain separator | Structure |
|------------------|-----------|
| `PCI/spal-commit/v1` | S-PAL policy commitment |
| `PCI/spal-pubin/v1` | S-PAL zero-knowledge public input |
| `PCI/did-envelope/v1` | DID-signed request envelope |
| `PCI/spal-payment/v1` | Payment commitment (nested in the public input) |

A new context or a breaking change to an existing structure gets a new registry
entry (bump the version suffix), never a silent reuse.

## Structures in Scope

Field order below is normative — implementations MUST encode fields in the
order listed. The **Kind** column states whether a field is variable-length
(length-prefixed, per rule 1) or fixed-width (raw, per rule 2). The bolded
fields are variable-length: they are PCI's actual exposure to re-partitioning,
and the reason this spec exists. The remaining fields are fixed-width and were
already injective under raw concatenation.

### 1. S-PAL policy commitment — `PCI/spal-commit/v1`

Binds a policy's identity to its content. Its digest is the `policy_hash`
consumed by the zero-knowledge public input (structure 2).

| # | Field | Kind | Width | Description |
|---|-------|------|-------|-------------|
| 0 | `domain_sep` | var | — | `PCI/spal-commit/v1` |
| 1 | **`policy_id`** | var | — | S-PAL policy id (`spal:did:pci:{chain}:{addr}:{name}`) |
| 2 | **`owner_did`** | var | — | DID of the policy owner (`did:pci:{chain}:{addr}`) |
| 3 | `schema_version` | fixed | 2 B | uint16 BE; `0x0100` for S-PAL `1.0` |
| 4 | `content_hash` | fixed | 32 B | Digest of the policy body (see below) |

`content_hash` is a 32-byte digest of the policy body. It is computed by
applying this same encoding rule to the body's ordered fields and hashing the
result. pci-contracts owns the concrete body field list, because the on-chain
`PolicyDatum` — not the full policy JSON — is the structure actually committed;
it MUST pin that field list and compute `content_hash` under this rule. From
the perspective of this spec, `content_hash` is a fixed 32-byte input.

### 2. S-PAL zero-knowledge public input — `PCI/spal-pubin/v1`

The public input a policy-enforcement verifier reconstructs from trusted
context (per [ADR-005](https://github.com/peteski22/pci-docs/blob/main/decisions/005-cardano-l1-vs-midnight-sidechain-for-zkp.md)),
rather than accepting from the prover. This is the byte-exact form of that
reconstruction. The single variable-length member, `context_scope`, is the
field that made the pattern forgeable when concatenated raw.

| # | Field | Kind | Width | Description |
|---|-------|------|-------|-------------|
| 0 | `domain_sep` | var | — | `PCI/spal-pubin/v1` |
| 1 | `script_hash` | fixed | 28 B | Blake2b-224 hash of the Plutus V3 own-script |
| 2 | `policy_hash` | fixed | 32 B | Digest of the S-PAL policy commitment (structure 1) |
| 3 | **`context_scope`** | var | — | Data scope path (e.g. `medical/diagnosis_codes`) |
| 4 | `required_proof_hash` | fixed | 32 B | Verifier binding, from `PolicyDatum` |
| 5 | `subject_hash` | fixed | 28 B | Blake2b-224 of the requester DID |
| 6 | `access_time` | fixed | 8 B | uint64 BE, canonicalised access time |
| 7 | `payment_commitment` | fixed | 32 B | Digest of the payment commitment (below) |

The 28- and 32-byte widths follow Cardano's Blake2b-224 script/credential
hashes and Blake2b-256 digests; a downstream circuit that pins a different
fixed width (for example a different digest, or a BLS12-381 point) remains
injective, provided the width is fixed by its schema. The width, not the
specific value, is this spec's contract.

#### Payment commitment (nested) — `PCI/spal-payment/v1`

`payment_commitment` (field 7 above) is the digest of this nested preimage.
Both non-separator fields are fixed-width, so the structure is injective by
construction; the separator makes it non-collidable with any other context.

| # | Field | Kind | Width | Description |
|---|-------|------|-------|-------------|
| 0 | `domain_sep` | var | — | `PCI/spal-payment/v1` |
| 1 | `currency` | fixed | 1 B | uint8 enum: `sats`=1, `lovelace`=2, `usd_cents`=3 |
| 2 | `amount` | fixed | 8 B | uint64 BE, amount in the currency's smallest unit |

### 3. DID-signed request envelope — `PCI/did-envelope/v1`

The envelope an agent signs when making a request. The signature is computed
over the hash of this encoded preimage and is **not** itself part of the
preimage.

> **Status:** the request envelope for agent-to-agent commerce
> ([pci-agent#7](https://github.com/peteski22/pci-agent/issues/7)) is not yet
> built. This structure is the canonical form pci-agent#7 implements against;
> the field set may be refined when that work lands, under a new version suffix.

| # | Field | Kind | Width | Description |
|---|-------|------|-------|-------------|
| 0 | `domain_sep` | var | — | `PCI/did-envelope/v1` |
| 1 | **`sender_did`** | var | — | DID of the signing agent |
| 2 | **`recipient_did`** | var | — | DID of the target agent or service |
| 3 | **`action`** | var | — | Request action (e.g. `negotiate`, `proof.submit`) |
| 4 | **`policy_id`** | var | — | Related S-PAL policy id; may be empty |
| 5 | `nonce` | fixed | 16 B | Single-use random nonce (replay protection) |
| 6 | `issued_at` | fixed | 8 B | uint64 BE, unix seconds |
| 7 | `expires_at` | fixed | 8 B | uint64 BE, unix seconds |
| 8 | `body_hash` | fixed | 32 B | Digest of the request payload |

`body_hash` is a 32-byte digest of the request payload, computed by applying
this encoding rule to the payload's ordered fields; pci-agent#7 owns that field
list. From this spec's perspective it is a fixed 32-byte input.

## Cardano Guidance

On Cardano, the idiomatic way to construct an injective preimage is to hash
over `SerialiseData` (which serialises `PlutusData` to CBOR with self-describing
field boundaries) rather than over `AppendByteString` concatenation. This is
precisely the remedy BlockSec identified for the `TreasuryCheck` bug — and the
safe primitive Wanchain's own contract already had available but did not apply
on the signature path.

`SerialiseData` is guidance for producing Cardano-side preimages injectively; it
is **not** a second canonical wire format. Any preimage that crosses layers
(committed on one surface, verified on another) MUST use the length-prefixed
encoding defined above, so that both sides reconstruct identical bytes and
therefore identical hashes. Two encodings for one cross-layer preimage is a
correctness trap and is not permitted.

## Test Vectors

Machine-readable test vectors are in
[`../schemas/encoding/v1.0/test-vectors.json`](../schemas/encoding/v1.0/test-vectors.json).
They are **hash-agnostic**: every value is an *encoding* (the bytes that would
be hashed), never a digest. Fixed-width digest inputs use recognisable
placeholder byte patterns.

The file covers:

- One worked encoding per structure (including the nested payment commitment and
  an empty-but-present variable-length field).
- **Adversarial re-partitioning cases**, each showing that the raw concatenation
  collides while the canonical encoding stays distinct:
  - a boundary move between two variable-length fields
    (`("alice","bob123")` vs `("aliceb","ob123")`);
  - a **domain-separator** boundary move, proving the separator is not exempt;
  - a re-partition of a real S-PAL identifier pair — the PCI-specific form of
    the Wanchain attack.
- The over-length-field rejection rule.

## Reference Encoding (pseudocode)

```
function encode(fields):
    out = empty byte buffer
    for field in fields:            # in schema-defined order
        if field.kind == VARIABLE:
            assert len(field.bytes) <= 0xFFFFFFFF   # else reject
            out += uint32_be(len(field.bytes))
            out += field.bytes
        else:                       # FIXED
            assert len(field.bytes) == field.width  # else reject
            out += field.bytes
    return out
# The domain separator is the first field, with kind == VARIABLE.
```

## Security Considerations

- The length prefix is load-bearing: an implementation that accepts an
  over-length field and wraps its uint32 length reintroduces re-partitioning.
  Reject, never wrap.
- The fixed-width exemption is only safe while widths are enforced. A field
  documented as fixed but not width-checked at the boundary is a latent
  re-partitioning bug.
- Domain separation and injectivity defend against different attacks; this
  encoding provides both, but only because the separator is length-prefixed
  like every other field. Neither substitutes for the other.
- This encoding hardens the preimage. It does not replace signature
  verification, nonce/expiry replay checks, or the trusted-context
  reconstruction of public inputs (ADR-005) — those remain required.

## References

- [ADR-007: Cardano ↔ Midnight Interop Path](https://github.com/peteski22/pci-docs/blob/main/decisions/007-cardano-midnight-interop-path.md) — the requirement this spec fulfils
- [ADR-005: Cardano L1 vs Midnight Sidechain for ZKP](https://github.com/peteski22/pci-docs/blob/main/decisions/005-cardano-l1-vs-midnight-sidechain-for-zkp.md) — the public-input reconstruction pattern this hardens
- Downstream implementations: pci-contracts (S-PAL commitments, on-chain verifiers), pci-zkp (circuit public inputs), pci-agent (DID-signed envelopes, [#7](https://github.com/peteski22/pci-agent/issues/7)), pci-identity, pci-demo
