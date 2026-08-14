# S-PAL Public Input Encoding

This document pins the canonical byte encoding of the S-PAL zero-knowledge
**public input** (`pub`) and the interim **proof commitment** that binds a proof
to it. It is the Cardano-side rendering of the structures registered in
pci-spec `protocols/preimage-encoding.md` (`PCI/spal-pubin/v2`,
`PCI/spal-payment/v2`): the Aiken validator (`validators/spal.ak`), the pci-zkp
circuit/prover, and the pci-spec reference implementation MUST reproduce this
encoding **byte-for-byte**. A one-byte difference between any two
implementations rejects every proof.

Rationale and scope: see
[pci-contracts issue #15](https://github.com/peteski22/pci-contracts/issues/15),
[pci-contracts issue #17](https://github.com/peteski22/pci-contracts/issues/17),
[ADR-005](https://github.com/peteski22/pci-docs/blob/main/decisions/005-cardano-l1-vs-midnight-sidechain-for-zkp.md)
("The public-input pattern is portable"), and
[ADR-007](https://github.com/peteski22/pci-docs/blob/main/decisions/007-cardano-midnight-interop-path.md)
(injective, domain-separated preimages).

## Principle

The validator **reconstructs** the public input from context it already trusts
— it never reads a public input supplied by the prover. Every component of
`pub` comes from the domain-separation tag (constant), the own-script hash and
the spending output reference (script context), the policy datum (script
parameters), or constrained redeemer components. Because the validator computes
`pub` rather than accepting it, a proof produced for policy A cannot be replayed
against policy B, a different requester, or a different spent UTxO.

The preimage uses the canonical injective encoding defined in pci-spec
`protocols/preimage-encoding.md`: every variable-length field — the domain
separator included — is emitted as a 4-byte big-endian length prefix followed
by its raw bytes; every fixed-width field is emitted raw at its schema-pinned
width, and the validator enforces those widths. No two distinct field tuples
share an encoding, so a committed preimage cannot be re-partitioned into
another valid one (the Wanchain `TreasuryCheck` failure mode).

### On-chain vs off-chain assurance

While ZK verification runs off-chain there is no on-chain Groth16 verifier (see
[Non-goals](#interim-binding-no-on-chain-verifier-yet)). Every input to `pub` is
visible on-chain, so `pub` — and therefore `blake2b_256(pub)` — is publicly
recomputable by anyone assembling the transaction. The on-chain binding check
therefore proves the redeemer is bound to this exact context (policy, requester,
payment, spent UTxO); it does **not** prove that a valid proof exists.
Proof-of-knowledge is established off-chain, where the verifier requires a valid
proof for this `pub`. Downstream code MUST NOT treat a passing on-chain binding
as evidence that a proof was generated.

## Version

- **Structure:** `PCI/spal-pubin/v2` from the pci-spec domain-separator
  registry. The registry string is the domain separator; it MUST be used
  verbatim. Bumping the registry version changes every `pub`; change the
  registry, this document, and the validator together.
- The earlier ad-hoc tag `pci:spal:pubinput:v1` (raw-concatenated, unprefixed)
  is retired and MUST NOT be produced or accepted.

## Public input preimage

`pub` is the Blake2b-256 digest of the canonical encoding of the following
fields, in this exact order. `var` fields are length-prefixed
(`uint32_be(len) || bytes`); `fixed` fields are emitted raw at exactly the
stated width, which the validator enforces.

| # | Field                  | Kind  | Width | Source              | Encoding                                                     |
|---|------------------------|-------|-------|---------------------|--------------------------------------------------------------|
| 0 | `domain_sep`           | var   | 17 B  | constant            | UTF-8 bytes of `PCI/spal-pubin/v2`                           |
| 1 | `script_hash`          | fixed | 28 B  | script context      | Plutus V3 own-script hash (Blake2b-224 of the script)        |
| 2 | `spend_ref_hash`       | fixed | 32 B  | script context      | Blake2b-256 of the canonical PlutusData CBOR of the spending `OutputReference` |
| 3 | `policy_content_hash`  | fixed | 32 B  | policy datum        | Blake2b-256 of the canonical PlutusData CBOR of `PolicyDatum` |
| 4 | `context_scope`        | var   | —     | policy datum        | `PolicyDatum.context_scope`, raw bytes                       |
| 5 | `required_proof_hash`  | fixed | 32 B  | policy datum        | `PolicyDatum.required_proof_hash`, raw                       |
| 6 | `subject_hash`         | fixed | 28 B  | redeemer            | Blake2b-224 of `AccessRedeemer.requester_did`                |
| 7 | `access_time`          | fixed | 8 B   | redeemer            | `AccessRedeemer.access_time` as 8-byte big-endian            |
| 8 | `payment_commitment`   | fixed | 32 B  | policy + redeemer   | see [Payment commitment](#payment-commitment)                |

```text
preimage = uint32_be(17) || "PCI/spal-pubin/v2"
        || script_hash
        || spend_ref_hash
        || policy_content_hash
        || uint32_be(len(context_scope)) || context_scope
        || required_proof_hash
        || subject_hash
        || access_time
        || payment_commitment

pub = Blake2b-256(preimage)          // 32 bytes
```

`policy_content_hash` (field 3) already commits to the entire `PolicyDatum`,
including `context_scope`, `required_proof_hash`, and `payment_currency`.
Fields 4, 5, and the currency portion of 8 are therefore redundant with
`policy_content_hash`; they are retained deliberately so each field the circuit
consumes is bound explicitly and mirrors the circuit's public-input layout.

### Notes on each field

- **`script_hash`** binds `pub` to this specific deployed script instance,
  preventing cross-deployment replay. On-chain it is the payment credential of
  the script's own spending input, always 28 bytes; the validator enforces the
  width regardless.
- **`spend_ref_hash`** binds `pub` to the specific UTxO being spent (the
  spending `OutputReference` — transaction id plus output index), preventing
  replay of a commitment against another UTxO that carries an identical policy
  and redeemer within the same deployment.
- **`policy_content_hash`** is the Blake2b-256 of the canonical PlutusData
  **CBOR** encoding of the `PolicyDatum` (Aiken `cbor.serialise`; off-chain,
  the same canonical Plutus Data CBOR, e.g. Lucid `Data.to`). Both sides must
  serialise the identical datum shape (7 fields, field order as in
  `PolicyDatum`). Digests of Plutus values use the chain's canonical CBOR —
  already injective (self-describing field boundaries) and already the one
  encoding both surfaces share; see the Cardano guidance in the pci-spec
  encoding document. This digest is the `content_hash` of the off-chain S-PAL
  policy commitment (`PCI/spal-commit/v1`).
- **`context_scope`** is included raw and length-prefixed, so the circuit
  consumes the actual scope bytes rather than a digest of them.
- **`required_proof_hash`** is the policy's verifier binding and MUST be a
  32-byte digest when a proof is required. A policy whose `required_proof_hash`
  is non-empty but not 32 bytes cannot be spent through the proof path: the
  width check halts and the transaction is rejected.
- **`access_time`** is a non-negative POSIX millisecond timestamp; 8 bytes hold
  timestamps up to year ~292 million. A value that does not fit in 8 bytes (or
  is negative) makes the on-chain reconstruction fail, rejecting the
  transaction.

### Payment commitment

`payment_commitment` (field 8) is the Blake2b-256 digest of the nested
`PCI/spal-payment/v2` preimage:

| # | Field        | Kind  | Width | Encoding                                        |
|---|--------------|-------|-------|-------------------------------------------------|
| 0 | `domain_sep` | var   | 19 B  | UTF-8 bytes of `PCI/spal-payment/v2`            |
| 1 | `currency`   | var   | —     | settlement currency encoding (below)            |
| 2 | `amount`     | fixed | 8 B   | `payment_amount` as 8-byte big-endian           |

```text
currency_bytes(Ada)                          = 0x02                    // lovelace
currency_bytes(NativeToken{policy_id, name}) = 0x04 || policy_id || name

payment_preimage = uint32_be(19) || "PCI/spal-payment/v2"
                || uint32_be(len(currency_bytes)) || currency_bytes
                || amount_8be

payment_commitment = Blake2b-256(payment_preimage)
```

The currency tags come from the pci-spec settlement currency registry
(`sats`=0x01, `lovelace`=0x02, `usd_cents`=0x03, Cardano native asset=0x04);
only 0x02 and 0x04 are producible from this validator's `PaymentCurrency`. For
a native asset, `policy_id` MUST be exactly 28 bytes (enforced — the validator
halts otherwise) and `asset_name` is 0–32 bytes, terminal. The internal layout
is unambiguous because the tag and policy id are fixed-width and the asset name
is terminal; the whole `currency` field is additionally length-prefixed.

`amount_8be` uses big-endian encoding at a fixed 8-byte width. A negative or
oversized amount cannot be encoded (Aiken `bytearray.from_int_big_endian` halts
on values that do not fit in the requested width), which makes the on-chain
reconstruction fail and rejects the transaction — so distinct amounts cannot
collide.

## Conformance

The canonical encodings above are covered by test vectors in pci-spec
(`schemas/encoding/v1.0/test-vectors.json`), generated by the reference
encoder. `validators/spal.ak` carries byte-exact conformance tests against the
`spal-pubin-diagnosis-codes`, `payment-commitment-2-ada`, and
`payment-commitment-cardano-native-usdcx` vectors, plus the adversarial
re-partitioning cases (a moved field boundary and a moved domain-separator
boundary both collide under raw concatenation and stay distinct under this
encoding).

## Fr reduction (circuit side)

The 32-byte `pub` digest is turned into a single field element for the Groth16
/ Compact circuit by reducing it modulo the circuit's scalar field order `r`
(for BLS12-381, the standard scalar field modulus):

```text
pub_field = Fr(pub) = big_endian_to_integer(pub) mod r
```

This reduction is deterministic and identical on both sides. The Aiken validator
does not perform it: while ZK verification runs off-chain there is no on-chain
Groth16 verifier (see issue #15 non-goals), so the validator binds the 32-byte
digest directly (below). If an on-chain verifier is later added under ADR-005,
it consumes `pub_field`.

## Interim binding (no on-chain verifier yet)

Until an on-chain Groth16 verifier exists, the validator enforces the binding
through a commitment carried in the redeemer:

- `AccessRedeemer.proof_commitment` MUST equal `Blake2b-256(pub)` whenever
  `PolicyDatum.required_proof_hash` is non-empty.
- When `required_proof_hash` is empty, no proof is required and
  `proof_commitment` is unconstrained (conventionally empty).

The off-chain prover is required to have produced a valid ZK proof for exactly
this `pub` and to commit to it as `Blake2b-256(pub)`. On-chain this rejects any
transaction whose commitment is not bound to the reconstructed `pub`; off-chain
verification of the proof itself closes the remaining gap.

```text
proof_commitment == Blake2b-256(pub)             // required_proof_hash non-empty
```

## Off-chain reproduction checklist

1. Serialise the identical `PolicyDatum` (same field order and values) to
   canonical Plutus CBOR and Blake2b-256 it for `policy_content_hash`. Do the
   same for the spending `OutputReference` to obtain `spend_ref_hash`.
2. Use the registry domain separators verbatim (`PCI/spal-pubin/v2`,
   `PCI/spal-payment/v2`), each length-prefixed like any variable-length field.
3. Length-prefix `context_scope` and the currency bytes with 4-byte big-endian
   lengths; encode `access_time` and `payment_amount` as big-endian at the
   fixed 8-byte width.
4. Concatenate fields 0–8 in order and Blake2b-256 the result to obtain `pub`.
5. Commit `Blake2b-256(pub)` into the redeemer's `proof_commitment`.
6. For the circuit's public input, reduce `pub` modulo `r`.
