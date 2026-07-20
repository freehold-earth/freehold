// S-PAL (Sovereign Privacy & Access Language) Validator
// Enforces data sovereignty policies on Cardano

use aiken/cbor
use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{from_lovelace, lovelace_of, quantity_of}
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}

/// Domain-separation tag for S-PAL public inputs.
///
/// Prefixed into every reconstructed public input so S-PAL's `pub` values are
/// non-collidable with any other circuit that reuses the same field. Versioned;
/// a change here changes every `pub`. This value MUST be reproduced byte-for-byte
/// by every off-chain prover and circuit that recomputes the public input.
/// See PUBLIC_INPUT.md for the full encoding.
const domain_sep_spal: ByteArray = "pci:spal:pubinput:v1"

/// Identity linkage rules for privacy-preserving verification
pub type IdentityLinkage {
  ephemeral_required: Bool,
  proof_of_root_allowed: Bool,
  zk_continuity_allowed: Bool,
}

/// Payment currency - Ada or a native token (e.g., USDCx)
pub type PaymentCurrency {
  Ada
  NativeToken { policy_id: ByteArray, asset_name: ByteArray }
}

/// S-PAL Policy Datum - stored with the policy UTxO
pub type PolicyDatum {
  owner: ByteArray,
  min_payment: Int,
  max_retention_ms: Int,
  identity_linkage: IdentityLinkage,
  required_proof_hash: ByteArray,
  context_scope: ByteArray,
  payment_currency: PaymentCurrency,
}

/// Redeemer for policy access
///
/// `proof_commitment` is a commitment to the off-chain proof artefact, set to
/// `blake2b_256(pub)` where `pub` is the public input the validator reconstructs
/// from trusted context. It replaces the former opaque `proof_reference`: the
/// prover no longer supplies a public input.
///
/// The on-chain check binds this commitment to the reconstructed `pub`, so it is
/// tied to the policy, requester, payment, and the specific UTxO being spent.
/// While ZK verification runs off-chain there is no on-chain Groth16 verifier
/// (see PUBLIC_INPUT.md), so `pub` — and therefore `blake2b_256(pub)` — is
/// publicly recomputable from on-chain data: the on-chain check proves the
/// redeemer is bound to this exact context, not that a valid proof exists.
/// Proof-of-knowledge is established off-chain, where the verifier requires a
/// valid proof for this `pub`.
///
/// The remaining fields (`requester_did`, `access_time`, `payment_amount`) are
/// the constrained inputs the validator feeds into the public-input
/// reconstruction — never the reconstructed public input itself.
pub type AccessRedeemer {
  requester_did: ByteArray,
  proof_commitment: ByteArray,
  access_time: Int,
  payment_amount: Int,
}

/// Validates that the policy owner has signed the transaction
fn check_owner_signature(tx: Transaction, owner: ByteArray) -> Bool {
  list.any(tx.extra_signatories, fn(sig) { sig == owner })
}

/// Check if DID is valid did:key format
/// did:key DIDs start with "did:key:z" (9 bytes: 0x6469643a6b65793a7a)
fn is_valid_did_key(did: ByteArray) -> Bool {
  // "did:key:z" in hex
  let prefix = #"6469643a6b65793a7a"
  let prefix_len = 9

  if bytearray.length(did) < prefix_len {
    False
  } else {
    bytearray.take(did, prefix_len) == prefix
  }
}

/// Validates identity linkage requirements
fn check_identity_linkage(
  requester_did: ByteArray,
  linkage: IdentityLinkage,
) -> Bool {
  if linkage.ephemeral_required {
    is_valid_did_key(requester_did)
  } else {
    True
  }
}

/// Validates payment meets minimum requirement
/// Supports both Ada (lovelace) and native token (e.g., USDCx) payments.
/// For native token payments, the on-chain outputs must also carry min-ADA,
/// but only the token quantity is checked against min_payment.
fn check_payment(
  tx: Transaction,
  owner: ByteArray,
  min_payment: Int,
  claimed_payment: Int,
  payment_currency: PaymentCurrency,
) -> Bool {
  if min_payment == 0 {
    True
  } else {
    let meets_minimum = claimed_payment >= min_payment
    let owner_address = Address {
      payment_credential: VerificationKey(owner),
      stake_credential: None,
    }
    let payment_to_owner = list.foldl(
      tx.outputs,
      0,
      fn(output, acc) {
        if output.address == owner_address {
          when payment_currency is {
            Ada -> acc + lovelace_of(output.value)
            NativeToken { policy_id, asset_name } ->
              acc + quantity_of(output.value, policy_id, asset_name)
          }
        } else {
          acc
        }
      },
    )
    meets_minimum && payment_to_owner >= claimed_payment
  }
}

/// Validates a proof commitment is present when the policy requires a proof.
///
/// Shape check only: it confirms the redeemer carries a non-empty commitment.
/// The cryptographic binding of that commitment to the policy, requester, and
/// transaction context is enforced separately via the reconstructed public input.
fn check_proof_requirement(
  proof_commitment: ByteArray,
  required_proof_hash: ByteArray,
) -> Bool {
  if bytearray.length(required_proof_hash) == 0 {
    True
  } else {
    bytearray.length(proof_commitment) > 0
  }
}

/// Canonical byte encoding of a payment currency, used inside the payment
/// commitment. `Ada` is the single tag byte `0x00`; a native token is the tag
/// byte `0x01` followed by its policy id (a 28-byte Cardano policy hash) and
/// asset name (0–32 bytes). The variable-length asset name is last, so with the
/// fixed-width policy id and a prepended fixed-width amount the encoding is
/// unambiguous. The currency is authored by the policy owner in the trusted
/// datum, which is itself committed via `policy_hash`.
fn payment_currency_bytes(currency: PaymentCurrency) -> ByteArray {
  when currency is {
    Ada -> #"00"
    NativeToken { policy_id, asset_name } ->
      #"01"
        |> bytearray.concat(policy_id)
        |> bytearray.concat(asset_name)
  }
}

/// Commitment binding the payment currency and claimed amount into a fixed-width
/// digest. The amount is encoded as 16-byte big-endian (large enough for native
/// token quantities) and prepended to the currency bytes so the concatenation is
/// unambiguous.
fn payment_commitment(currency: PaymentCurrency, amount: Int) -> ByteArray {
  let preimage =
    bytearray.from_int_big_endian(amount, 16)
      |> bytearray.concat(payment_currency_bytes(currency))
  crypto.blake2b_256(preimage)
}

/// Reconstruct the S-PAL public input from context the validator already trusts.
///
/// Every component is derived from trusted context — the domain-separation tag
/// (constant), the own-script hash and the spending output reference (script
/// context), the policy datum (script parameters), and the constrained redeemer
/// components. The prover cannot substitute a public input: the validator
/// computes one rather than reading one. Including the spending output reference
/// binds `pub` to the specific UTxO being spent, so a commitment produced for
/// one spend cannot be replayed against another UTxO carrying an identical
/// policy and redeemer.
///
/// All components are fixed-width — hash digests or fixed-size big-endian
/// integers — so the concatenation is unambiguous. The exact encoding is pinned
/// in PUBLIC_INPUT.md and MUST be reproduced byte-for-byte off-chain; a
/// one-byte difference rejects every proof.
fn reconstruct_public_input(
  script_hash: ByteArray,
  spend_ref: OutputReference,
  policy: PolicyDatum,
  redeemer: AccessRedeemer,
) -> ByteArray {
  let spend_ref_hash = crypto.blake2b_256(cbor.serialise(spend_ref))
  let policy_hash = crypto.blake2b_256(cbor.serialise(policy))
  let context_scope_hash = crypto.blake2b_256(policy.context_scope)
  let required_proof_hash_hash =
    crypto.blake2b_256(policy.required_proof_hash)
  let subject_hash = crypto.blake2b_224(redeemer.requester_did)
  let access_time_bytes =
    bytearray.from_int_big_endian(redeemer.access_time, 8)
  let payment_commitment_bytes =
    payment_commitment(policy.payment_currency, redeemer.payment_amount)

  let preimage =
    domain_sep_spal
      |> bytearray.concat(script_hash)
      |> bytearray.concat(spend_ref_hash)
      |> bytearray.concat(policy_hash)
      |> bytearray.concat(context_scope_hash)
      |> bytearray.concat(required_proof_hash_hash)
      |> bytearray.concat(subject_hash)
      |> bytearray.concat(access_time_bytes)
      |> bytearray.concat(payment_commitment_bytes)

  crypto.blake2b_256(preimage)
}

/// Resolve the hash of the currently-executing spending script from the script
/// context. A spend validator's own input is always present and always sits at a
/// script address, so both patterns are total for this validator.
fn own_script_hash(tx: Transaction, utxo: OutputReference) -> ByteArray {
  expect Some(input) = transaction.find_input(tx.inputs, utxo)
  expect Script(hash) = input.output.address.payment_credential
  hash
}

validator spal {
  spend(
    datum: Option<PolicyDatum>,
    redeemer: AccessRedeemer,
    utxo: OutputReference,
    tx: Transaction,
  ) {
    when datum is {
      Some(policy) -> {
        let owner_signed = check_owner_signature(tx, policy.owner)
        let identity_valid = check_identity_linkage(
          redeemer.requester_did,
          policy.identity_linkage,
        )
        let proof_shape_valid = check_proof_requirement(
          redeemer.proof_commitment,
          policy.required_proof_hash,
        )
        // Reconstruct the ZK public input from trusted context and require the
        // redeemer's proof commitment to bind to it. The validator never reads a
        // public input the prover supplied; it computes one. Only evaluated when
        // the policy requires a proof, to avoid needless on-chain work.
        let proof_bound =
          if bytearray.length(policy.required_proof_hash) == 0 {
            True
          } else {
            let public_input =
              reconstruct_public_input(
                own_script_hash(tx, utxo),
                utxo,
                policy,
                redeemer,
              )
            redeemer.proof_commitment == crypto.blake2b_256(public_input)
          }
        let payment_valid = check_payment(
          tx,
          policy.owner,
          policy.min_payment,
          redeemer.payment_amount,
          policy.payment_currency,
        )
        owner_signed && identity_valid && proof_shape_valid && proof_bound && payment_valid
      }
      None -> False
    }
  }

  else(_) {
    fail
  }
}

// Tests
test check_owner_signature_valid() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let tx = Transaction { ..transaction.placeholder, extra_signatories: [owner] }
  check_owner_signature(tx, owner)
}

test check_owner_signature_invalid() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let other = #"1111111111111111111111111111111111111111111111111111111111111111"
  let tx = Transaction { ..transaction.placeholder, extra_signatories: [other] }
  !check_owner_signature(tx, owner)
}

test is_valid_did_key_valid() {
  // "did:key:z6Mk..." format (truncated for test)
  // "did:key:z6Mk" in hex
  let did = #"6469643a6b65793a7a364d6b"
  is_valid_did_key(did)
}

test is_valid_did_key_invalid_prefix() {
  // "did:web:example" in hex - wrong method
  let did = #"6469643a7765623a6578616d706c65"
  !is_valid_did_key(did)
}

test is_valid_did_key_too_short() {
  // "did:key" in hex - missing 'z' prefix
  let did = #"6469643a6b6579"
  !is_valid_did_key(did)
}

test check_identity_linkage_ephemeral_required_valid() {
  let did = #"6469643a6b65793a7a364d6b54657374"
  let linkage = IdentityLinkage {
    ephemeral_required: True,
    proof_of_root_allowed: True,
    zk_continuity_allowed: False,
  }
  check_identity_linkage(did, linkage)
}

test check_identity_linkage_ephemeral_required_invalid() {
  let did = #"6469643a7765623a6578616d706c65"
  let linkage = IdentityLinkage {
    ephemeral_required: True,
    proof_of_root_allowed: True,
    zk_continuity_allowed: False,
  }
  !check_identity_linkage(did, linkage)
}

test check_identity_linkage_ephemeral_not_required() {
  let did = #"6469643a7765623a6578616d706c65"
  let linkage = IdentityLinkage {
    ephemeral_required: False,
    proof_of_root_allowed: True,
    zk_continuity_allowed: True,
  }
  check_identity_linkage(did, linkage)
}

test check_proof_not_required() {
  check_proof_requirement(#"", #"")
}

test check_proof_required_and_provided() {
  let proof_commitment = #"6d69646e696768743a74783a616263313233"
  let required_hash = #"aabbccdd"
  check_proof_requirement(proof_commitment, required_hash)
}

test check_proof_required_but_missing() {
  let required_hash = #"aabbccdd"
  !check_proof_requirement(#"", required_hash)
}

// Public-input reconstruction tests

/// A sample policy datum for reconstruction tests.
fn sample_policy() -> PolicyDatum {
  PolicyDatum {
    owner: #"0011223344556677889900112233445566778899001122334455667788990011",
    min_payment: 1_000_000,
    max_retention_ms: 86_400_000,
    identity_linkage: IdentityLinkage {
      ephemeral_required: True,
      proof_of_root_allowed: True,
      zk_continuity_allowed: False,
    },
    required_proof_hash: #"aabbccdd",
    context_scope: #"6d65646963616c2f646961676e6f736973",
    payment_currency: Ada,
  }
}

/// A sample access redeemer for reconstruction tests.
fn sample_redeemer() -> AccessRedeemer {
  AccessRedeemer {
    requester_did: #"6469643a6b65793a7a364d6b54657374",
    proof_commitment: #"",
    access_time: 1_700_000_000_000,
    payment_amount: 2_000_000,
  }
}

/// A sample spending output reference for reconstruction tests.
fn sample_spend_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"00000000000000000000000000000000000000000000000000000000000000aa",
    output_index: 0,
  }
}

test public_input_is_deterministic() {
  let sh = #"deadbeef"
  reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  ) == reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  )
}

test public_input_changes_with_script_hash() {
  reconstruct_public_input(
    #"deadbeef",
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  ) != reconstruct_public_input(
    #"cafebabe",
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  )
}

test public_input_changes_with_spend_ref() {
  let sh = #"deadbeef"
  let other_ref = OutputReference { ..sample_spend_ref(), output_index: 1 }
  reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  ) != reconstruct_public_input(
    sh,
    other_ref,
    sample_policy(),
    sample_redeemer(),
  )
}

test public_input_changes_with_policy() {
  let sh = #"deadbeef"
  let other_policy =
    PolicyDatum { ..sample_policy(), context_scope: #"6f74686572" }
  reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  ) != reconstruct_public_input(
    sh,
    sample_spend_ref(),
    other_policy,
    sample_redeemer(),
  )
}

test public_input_changes_with_subject() {
  let sh = #"deadbeef"
  let other_redeemer =
    AccessRedeemer {
      ..sample_redeemer(),
      requester_did: #"6469643a6b65793a7a3641414161",
    }
  reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  ) != reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    other_redeemer,
  )
}

test public_input_changes_with_access_time() {
  let sh = #"deadbeef"
  let other_redeemer =
    AccessRedeemer { ..sample_redeemer(), access_time: 1_700_000_000_001 }
  reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  ) != reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    other_redeemer,
  )
}

test public_input_changes_with_payment_amount() {
  let sh = #"deadbeef"
  let other_redeemer =
    AccessRedeemer { ..sample_redeemer(), payment_amount: 3_000_000 }
  reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    sample_redeemer(),
  ) != reconstruct_public_input(
    sh,
    sample_spend_ref(),
    sample_policy(),
    other_redeemer,
  )
}

/// A commitment produced for one subject must not satisfy the binding for
/// another subject's public input — i.e. a proof cannot be replayed across
/// requesters.
test proof_commitment_does_not_replay_across_subjects() {
  let sh = #"deadbeef"
  let other_redeemer =
    AccessRedeemer {
      ..sample_redeemer(),
      requester_did: #"6469643a6b65793a7a3641414161",
    }
  let commitment_a =
    crypto.blake2b_256(
      reconstruct_public_input(
        sh,
        sample_spend_ref(),
        sample_policy(),
        sample_redeemer(),
      ),
    )
  let public_input_b =
    reconstruct_public_input(
      sh,
      sample_spend_ref(),
      sample_policy(),
      other_redeemer,
    )
  commitment_a != crypto.blake2b_256(public_input_b)
}

/// A commitment produced for one UTxO must not satisfy the binding for another
/// UTxO carrying an identical policy and redeemer — i.e. a proof cannot be
/// replayed across UTxOs within the same deployment.
test proof_commitment_does_not_replay_across_utxos() {
  let sh = #"deadbeef"
  let other_ref = OutputReference { ..sample_spend_ref(), output_index: 1 }
  let commitment_a =
    crypto.blake2b_256(
      reconstruct_public_input(
        sh,
        sample_spend_ref(),
        sample_policy(),
        sample_redeemer(),
      ),
    )
  let public_input_b =
    reconstruct_public_input(sh, other_ref, sample_policy(), sample_redeemer())
  commitment_a != crypto.blake2b_256(public_input_b)
}

/// A transaction whose sole input is the policy UTxO at the given script
/// address, signed by `owner` — the minimum context for driving `spal.spend`
/// and resolving `own_script_hash`.
fn spend_tx(
  script_hash: ByteArray,
  utxo: OutputReference,
  owner: ByteArray,
) -> Transaction {
  let script_input =
    Input {
      output_reference: utxo,
      output: Output {
        address: Address {
          payment_credential: Script(script_hash),
          stake_credential: None,
        },
        value: from_lovelace(2_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }
  Transaction {
    ..transaction.placeholder,
    inputs: [script_input],
    extra_signatories: [owner],
  }
}

/// End-to-end: a commitment computed from the resolved script hash and the
/// spending context is accepted, exercising `own_script_hash` and the binding.
test spend_accepts_bound_proof_commitment() {
  let owner =
    #"0011223344556677889900112233445566778899001122334455667788990011"
  let script_hash = #"00112233445566778899aabbccddeeff00112233445566778899aabb"
  let utxo = sample_spend_ref()
  let policy = PolicyDatum { ..sample_policy(), owner: owner, min_payment: 0 }
  let base_redeemer = AccessRedeemer { ..sample_redeemer(), payment_amount: 0 }
  let public_input =
    reconstruct_public_input(script_hash, utxo, policy, base_redeemer)
  let redeemer =
    AccessRedeemer {
      ..base_redeemer,
      proof_commitment: crypto.blake2b_256(public_input),
    }
  spal.spend(Some(policy), redeemer, utxo, spend_tx(script_hash, utxo, owner))
}

/// End-to-end: a commitment not bound to the reconstructed public input is
/// rejected even though it is non-empty (passes the shape check).
test spend_rejects_unbound_proof_commitment() {
  let owner =
    #"0011223344556677889900112233445566778899001122334455667788990011"
  let script_hash = #"00112233445566778899aabbccddeeff00112233445566778899aabb"
  let utxo = sample_spend_ref()
  let policy = PolicyDatum { ..sample_policy(), owner: owner, min_payment: 0 }
  let redeemer =
    AccessRedeemer {
      ..sample_redeemer(),
      payment_amount: 0,
      proof_commitment: #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    }
  !spal.spend(Some(policy), redeemer, utxo, spend_tx(script_hash, utxo, owner))
}

/// End-to-end: when the policy requires no proof, the binding short-circuits and
/// an empty commitment is accepted.
test spend_accepts_when_no_proof_required() {
  let owner =
    #"0011223344556677889900112233445566778899001122334455667788990011"
  let script_hash = #"00112233445566778899aabbccddeeff00112233445566778899aabb"
  let utxo = sample_spend_ref()
  let policy =
    PolicyDatum {
      ..sample_policy(),
      owner: owner,
      min_payment: 0,
      required_proof_hash: #"",
    }
  let redeemer =
    AccessRedeemer {
      ..sample_redeemer(),
      payment_amount: 0,
      proof_commitment: #"",
    }
  spal.spend(Some(policy), redeemer, utxo, spend_tx(script_hash, utxo, owner))
}

test payment_commitment_is_deterministic() {
  payment_commitment(Ada, 1_000_000) == payment_commitment(Ada, 1_000_000)
}

test payment_commitment_changes_with_amount() {
  payment_commitment(Ada, 1_000_000) != payment_commitment(Ada, 2_000_000)
}

test payment_commitment_changes_with_currency() {
  let token =
    NativeToken {
      policy_id: #"aabb00112233445566778899aabbccddeeff00112233445566778899",
      asset_name: #"5553444378",
    }
  payment_commitment(Ada, 1_000_000) != payment_commitment(token, 1_000_000)
}

// Payment validation tests (Ada)
test check_payment_not_required() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let tx = Transaction { ..transaction.placeholder, outputs: [] }
  check_payment(tx, owner, 0, 0, Ada)
}

test check_payment_meets_minimum() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let owner_address = Address {
    payment_credential: VerificationKey(owner),
    stake_credential: None,
  }
  let output = Output {
    address: owner_address,
    value: from_lovelace(2_000_000),
    datum: NoDatum,
    reference_script: None,
  }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  check_payment(tx, owner, 1_000_000, 2_000_000, Ada)
}

test check_payment_below_minimum() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let owner_address = Address {
    payment_credential: VerificationKey(owner),
    stake_credential: None,
  }
  let output = Output {
    address: owner_address,
    value: from_lovelace(500_000),
    datum: NoDatum,
    reference_script: None,
  }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  !check_payment(tx, owner, 1_000_000, 500_000, Ada)
}

test check_payment_claimed_exceeds_actual() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let owner_address = Address {
    payment_credential: VerificationKey(owner),
    stake_credential: None,
  }
  let output = Output {
    address: owner_address,
    value: from_lovelace(1_000_000),
    datum: NoDatum,
    reference_script: None,
  }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  !check_payment(tx, owner, 1_000_000, 2_000_000, Ada)
}

// Payment validation tests (NativeToken)
test check_payment_native_token_not_required() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let token_policy = #"aabb00112233445566778899aabbccddeeff00112233445566778899"
  let token_name = #"5553444378"
  let tx = Transaction { ..transaction.placeholder, outputs: [] }
  check_payment(
    tx,
    owner,
    0,
    0,
    NativeToken { policy_id: token_policy, asset_name: token_name },
  )
}

test check_payment_native_token_meets_minimum() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let token_policy = #"aabb00112233445566778899aabbccddeeff00112233445566778899"
  let token_name = #"5553444378"
  let owner_address = Address {
    payment_credential: VerificationKey(owner),
    stake_credential: None,
  }
  // Build a value with lovelace (min-ADA) + native token
  let base_value = from_lovelace(2_000_000)
  let value_with_token = assets.add(
    base_value,
    token_policy,
    token_name,
    5_000_000,
  )
  let output = Output {
    address: owner_address,
    value: value_with_token,
    datum: NoDatum,
    reference_script: None,
  }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  check_payment(
    tx,
    owner,
    2_000_000,
    5_000_000,
    NativeToken { policy_id: token_policy, asset_name: token_name },
  )
}

test check_payment_native_token_below_minimum() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let token_policy = #"aabb00112233445566778899aabbccddeeff00112233445566778899"
  let token_name = #"5553444378"
  let owner_address = Address {
    payment_credential: VerificationKey(owner),
    stake_credential: None,
  }
  let base_value = from_lovelace(2_000_000)
  let value_with_token = assets.add(
    base_value,
    token_policy,
    token_name,
    500_000,
  )
  let output = Output {
    address: owner_address,
    value: value_with_token,
    datum: NoDatum,
    reference_script: None,
  }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  !check_payment(
    tx,
    owner,
    1_000_000,
    500_000,
    NativeToken { policy_id: token_policy, asset_name: token_name },
  )
}

// Claimed amount meets min_payment but actual token output is less than claimed
test check_payment_native_token_claimed_exceeds_actual() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let token_policy = #"aabb00112233445566778899aabbccddeeff00112233445566778899"
  let token_name = #"5553444378"
  let owner_address = Address {
    payment_credential: VerificationKey(owner),
    stake_credential: None,
  }
  // Owner receives sufficient lovelace but fewer tokens than claimed
  let base_value = from_lovelace(2_000_000)
  let value_with_token = assets.add(
    base_value,
    token_policy,
    token_name,
    4_000_000,
  )
  let output = Output {
    address: owner_address,
    value: value_with_token,
    datum: NoDatum,
    reference_script: None,
  }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  !check_payment(
    tx,
    owner,
    2_000_000,
    5_000_000,
    NativeToken { policy_id: token_policy, asset_name: token_name },
  )
}
