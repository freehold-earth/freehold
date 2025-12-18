// S-PAL (Sovereign Privacy & Access Language) Validator
// Enforces data sovereignty policies on Cardano

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, VerificationKey}
use cardano/assets.{from_lovelace, lovelace_of}
use cardano/transaction.{NoDatum, Output, OutputReference, Transaction}

/// Identity linkage rules for privacy-preserving verification
pub type IdentityLinkage {
  ephemeral_required: Bool,
  proof_of_root_allowed: Bool,
  zk_continuity_allowed: Bool,
}

/// S-PAL Policy Datum - stored with the policy UTxO
pub type PolicyDatum {
  owner: ByteArray,
  min_payment: Int,
  max_retention_ms: Int,
  identity_linkage: IdentityLinkage,
  required_proof_hash: ByteArray,
  context_scope: ByteArray,
}

/// Redeemer for policy access
pub type AccessRedeemer {
  requester_did: ByteArray,
  proof_reference: ByteArray,
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
fn check_payment(
  tx: Transaction,
  owner: ByteArray,
  min_payment: Int,
  claimed_payment: Int,
) -> Bool {
  if min_payment == 0 {
    True
  } else {
    let meets_minimum = claimed_payment >= min_payment
    let owner_address =
      Address {
        payment_credential: VerificationKey(owner),
        stake_credential: None,
      }
    let payment_to_owner =
      list.foldl(
        tx.outputs,
        0,
        fn(output, acc) {
          if output.address == owner_address {
            acc + lovelace_of(output.value)
          } else {
            acc
          }
        },
      )
    meets_minimum && payment_to_owner >= claimed_payment
  }
}

/// Validates proof reference exists if required
fn check_proof_requirement(
  proof_reference: ByteArray,
  required_proof_hash: ByteArray,
) -> Bool {
  if bytearray.length(required_proof_hash) == 0 {
    True
  } else {
    bytearray.length(proof_reference) > 0
  }
}

validator spal {
  spend(
    datum: Option<PolicyDatum>,
    redeemer: AccessRedeemer,
    _utxo: OutputReference,
    tx: Transaction,
  ) {
    when datum is {
      Some(policy) -> {
        let owner_signed = check_owner_signature(tx, policy.owner)
        let identity_valid =
          check_identity_linkage(
            redeemer.requester_did,
            policy.identity_linkage,
          )
        let proof_valid =
          check_proof_requirement(
            redeemer.proof_reference,
            policy.required_proof_hash,
          )
        let payment_valid =
          check_payment(
            tx,
            policy.owner,
            policy.min_payment,
            redeemer.payment_amount,
          )
        owner_signed && identity_valid && proof_valid && payment_valid
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
  let linkage =
    IdentityLinkage {
      ephemeral_required: True,
      proof_of_root_allowed: True,
      zk_continuity_allowed: False,
    }
  check_identity_linkage(did, linkage)
}

test check_identity_linkage_ephemeral_required_invalid() {
  let did = #"6469643a7765623a6578616d706c65"
  let linkage =
    IdentityLinkage {
      ephemeral_required: True,
      proof_of_root_allowed: True,
      zk_continuity_allowed: False,
    }
  !check_identity_linkage(did, linkage)
}

test check_identity_linkage_ephemeral_not_required() {
  let did = #"6469643a7765623a6578616d706c65"
  let linkage =
    IdentityLinkage {
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
  let proof_ref = #"6d69646e696768743a74783a616263313233"
  let required_hash = #"aabbccdd"
  check_proof_requirement(proof_ref, required_hash)
}

// Payment validation tests
test check_payment_not_required() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let tx = Transaction { ..transaction.placeholder, outputs: [] }
  check_payment(tx, owner, 0, 0)
}

test check_payment_meets_minimum() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let owner_address =
    Address { payment_credential: VerificationKey(owner), stake_credential: None }
  let output =
    Output {
      address: owner_address,
      value: from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  check_payment(tx, owner, 1_000_000, 2_000_000)
}

test check_payment_below_minimum() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let owner_address =
    Address { payment_credential: VerificationKey(owner), stake_credential: None }
  let output =
    Output {
      address: owner_address,
      value: from_lovelace(500_000),
      datum: NoDatum,
      reference_script: None,
    }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  !check_payment(tx, owner, 1_000_000, 500_000)
}

test check_payment_claimed_exceeds_actual() {
  let owner = #"0011223344556677889900112233445566778899001122334455667788990011"
  let owner_address =
    Address { payment_credential: VerificationKey(owner), stake_credential: None }
  let output =
    Output {
      address: owner_address,
      value: from_lovelace(1_000_000),
      datum: NoDatum,
      reference_script: None,
    }
  let tx = Transaction { ..transaction.placeholder, outputs: [output] }
  !check_payment(tx, owner, 1_000_000, 2_000_000)
}
