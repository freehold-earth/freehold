// S-PAL (Sovereign Privacy & Access Language) Validator
// Enforces data sovereignty policies on Cardano

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/transaction.{OutputReference, Transaction}

/// S-PAL Policy Datum - stored with the policy UTxO
pub type PolicyDatum {
  owner: ByteArray,
  min_payment: Int,
  max_retention_ms: Int,
  requires_ephemeral_did: Bool,
  required_proof_hash: ByteArray,
  context_scope: ByteArray,
}

/// Redeemer for policy access
pub type AccessRedeemer {
  requester_did: ByteArray,
  proof_reference: ByteArray,
  access_time: Int,
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

/// Validates DID is ephemeral if required
/// Ephemeral DIDs must be valid did:key format
fn check_ephemeral_did(
  requester_did: ByteArray,
  requires_ephemeral: Bool,
) -> Bool {
  if requires_ephemeral {
    // Must be a valid did:key (which are all ephemeral in our system)
    is_valid_did_key(requester_did)
  } else {
    True
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
        let ephemeral_valid =
          check_ephemeral_did(
            redeemer.requester_did,
            policy.requires_ephemeral_did,
          )
        let proof_valid =
          check_proof_requirement(
            redeemer.proof_reference,
            policy.required_proof_hash,
          )
        owner_signed && ephemeral_valid && proof_valid
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

test check_ephemeral_did_required_and_valid() {
  // "did:key:z6MkTest" in hex - valid did:key format
  let did = #"6469643a6b65793a7a364d6b54657374"
  check_ephemeral_did(did, True)
}

test check_ephemeral_did_required_but_invalid() {
  // "did:web:example" in hex - not a did:key
  let did = #"6469643a7765623a6578616d706c65"
  !check_ephemeral_did(did, True)
}

test check_ephemeral_did_not_required() {
  // Any DID is fine when ephemeral not required
  let did = #"6469643a7765623a6578616d706c65"
  check_ephemeral_did(did, False)
}

test check_proof_not_required() {
  check_proof_requirement(#"", #"")
}

test check_proof_required_and_provided() {
  let proof_ref = #"6d69646e696768743a74783a616263313233"
  let required_hash = #"aabbccdd"
  check_proof_requirement(proof_ref, required_hash)
}
