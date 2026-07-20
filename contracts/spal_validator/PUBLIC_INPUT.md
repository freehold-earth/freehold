# S-PAL Public Input Encoding

This document pins the canonical byte encoding of the S-PAL zero-knowledge
**public input** (`pub`) and the interim **proof commitment** that binds a proof
to it. It is the canonical artefact: the Aiken validator
(`validators/spal.ak`), the pci-zkp circuit/prover, and any pci-spec reference
implementation MUST reproduce this encoding **byte-for-byte**. A one-byte
difference between any two implementations rejects every proof.

Rationale and scope: see
[pci-contracts issue #15](https://github.com/peteski22/pci-contracts/issues/15)
and [ADR-005](https://github.com/peteski22/pci-docs/blob/main/decisions/005-cardano-l1-vs-midnight-sidechain-for-zkp.md)
("The public-input pattern is portable").

## Principle

The validator **reconstructs** the public input from context it already trusts
— it never reads a public input supplied by the prover. Every component of
`pub` comes from the domain-separation tag (constant), the own-script hash and
the spending output reference (script context), the policy datum (script
parameters), or constrained redeemer components. Because the validator computes
`pub` rather than accepting it, a proof produced for policy A cannot be replayed
against policy B, a different requester, or a different spent UTxO.

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

- **Encoding version:** `v1`
- **Domain-separation tag (`domain_sep_spal`):** the UTF-8 bytes of the ASCII
  string `pci:spal:pubinput:v1` — exactly 20 bytes:

  ```
  7063693a7370616c3a707562696e7075743a7631
  ```

  Bumping the version changes every `pub`; change the tag and this document
  together.

## Public input preimage

`pub` is the Blake2b-256 digest of the concatenation of the following
components, in this exact order. Every component is **fixed-width** (a hash
digest or a fixed-size big-endian integer), so the concatenation is unambiguous
and needs no length delimiters.

| # | Component                | Width (bytes) | Source              | Encoding                                                     |
|---|--------------------------|---------------|---------------------|-------------------------------------------------------------|
| 1 | `domain_sep_spal`        | 20            | constant            | UTF-8 bytes of `pci:spal:pubinput:v1` (see above)           |
| 2 | `script_hash`            | 28            | script context      | Plutus V3 own-script hash (Blake2b-224 of the script)       |
| 3 | `spend_ref_hash`         | 32            | script context      | Blake2b-256 of the canonical Plutus CBOR of the spending `OutputReference` |
| 4 | `policy_hash`            | 32            | policy datum        | Blake2b-256 of the canonical Plutus CBOR of `PolicyDatum`   |
| 5 | `context_scope_hash`     | 32            | policy datum        | Blake2b-256 of `PolicyDatum.context_scope`                  |
| 6 | `required_proof_hash_h`  | 32            | policy datum        | Blake2b-256 of `PolicyDatum.required_proof_hash`           |
| 7 | `subject_hash`           | 28            | redeemer            | Blake2b-224 of `AccessRedeemer.requester_did`               |
| 8 | `access_time`            | 8             | redeemer            | `AccessRedeemer.access_time` as 8-byte big-endian           |
| 9 | `payment_commitment`     | 32            | policy + redeemer   | see [Payment commitment](#payment-commitment)               |

```text
preimage = domain_sep_spal
        || script_hash
        || spend_ref_hash
        || policy_hash
        || context_scope_hash
        || required_proof_hash_h
        || subject_hash
        || access_time
        || payment_commitment

pub = Blake2b-256(preimage)          // 32 bytes
```

`policy_hash` (component 4) already commits to the entire `PolicyDatum`,
including `context_scope`, `required_proof_hash`, and `payment_currency`.
Components 5, 6, and the currency portion of 9 are therefore redundant with
`policy_hash`; they are retained deliberately so each field the circuit consumes
is bound explicitly and mirrors the circuit's public-input layout.

### Notes on each field

- **`script_hash`** binds `pub` to this specific deployed script instance,
  preventing cross-deployment replay. On-chain it is the payment credential of
  the script's own spending input.
- **`spend_ref_hash`** binds `pub` to the specific UTxO being spent (the
  spending `OutputReference` — transaction id plus output index), preventing
  replay of a commitment against another UTxO that carries an identical policy
  and redeemer within the same deployment.
- **`policy_hash`** is the Blake2b-256 of the Plutus **CBOR** encoding of the
  `PolicyDatum` (Aiken `cbor.serialise`; off-chain, the same canonical Plutus
  Data CBOR, e.g. Lucid `Data.to`). Both sides must serialise the identical
  datum shape (7 fields, field order as in `PolicyDatum`).
- **`access_time`** is a non-negative POSIX millisecond timestamp; 8 bytes hold
  timestamps up to year ~292 million. A value that does not fit in 8 bytes (or
  is negative) makes the on-chain reconstruction fail, rejecting the
  transaction.

### Payment commitment

`payment_commitment` (component 8) is a fixed-width digest binding the payment
currency and the claimed amount:

```text
currency_bytes(Ada)                              = 0x00
currency_bytes(NativeToken{policy_id, name})     = 0x01 || policy_id || name

payment_commitment = Blake2b-256(
  amount_16be                                    // payment_amount as 16-byte big-endian
  || currency_bytes                              // variable-length asset name is last
)
```

The amount is encoded as 16-byte big-endian (large enough for native-token
quantities) and placed **first** so the variable-length asset name is last and
the preimage stays unambiguous. `policy_id` is a 28-byte Cardano policy hash and
`asset_name` is 0–32 bytes; with the policy id fixed-width and the asset name
last, the currency bytes are unambiguous. The currency is authored by the policy
owner in the trusted datum and is committed by `policy_hash`, so a malformed
`policy_id` width is not attacker-controllable at spend time.

`amount_16be` uses big-endian encoding at a fixed 16-byte width. A negative or
oversized amount cannot be encoded (Aiken `bytearray.from_int_big_endian` halts
on values that do not fit in the requested width), which makes the on-chain
reconstruction fail and rejects the transaction — so distinct amounts cannot
collide.

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
   canonical Plutus CBOR and Blake2b-256 it for `policy_hash`. Do the same for
   the spending `OutputReference` to obtain `spend_ref_hash`.
2. Use the exact `domain_sep_spal` bytes above.
3. Encode `access_time` and `payment_amount` as big-endian at the fixed widths
   (8 and 16 bytes).
4. Concatenate components 1–9 in order and Blake2b-256 the result to obtain
   `pub`.
5. Commit `Blake2b-256(pub)` into the redeemer's `proof_commitment`.
6. For the circuit's public input, reduce `pub` modulo `r`.
