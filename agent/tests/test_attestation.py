"""The agent's check that an approval's DID is its holder's: the fixed vector
here is shared with identity/tests/did.test.ts, so both verifiers agree."""

import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from freehold_agent.attestation import approval_preimage, verify_approval
from freehold_agent.errors import AttestationInvalid

REQUEST_ID = "6f1d2c3b-4a5e-4f60-8a71-9b82c3d4e5f6"
SEED = bytes(range(1, 33))
DID = "did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7"
SIGNATURE = base64.b64decode(
    "ujz1IWArj/7Tu2V32Ugwcsqu6VUA596rBnkrhpWgSe2PwGRLLIQ0/JVIwnMVnOat+5CvzlwRfxwtHPFjJNCCAA=="
)

_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def did_key(key: Ed25519PrivateKey) -> str:
    """The did:key of a key, for tests that need a second holder."""
    from cryptography.hazmat.primitives import serialization

    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    value = int.from_bytes(b"\xed\x01" + raw, "big")
    text = ""
    while value:
        value, digit = divmod(value, 58)
        text = _ALPHABET[digit] + text
    return "did:key:z" + text


def sign_approval(key: Ed25519PrivateKey, request_id: str, did: str) -> bytes:
    return key.sign(approval_preimage(request_id, did))


def test_the_shared_vector_verifies() -> None:
    key = Ed25519PrivateKey.from_private_bytes(SEED)
    assert did_key(key) == DID
    assert sign_approval(key, REQUEST_ID, DID) == SIGNATURE
    verify_approval(DID, SIGNATURE, REQUEST_ID)


def test_the_preimage_reproduces_the_spec_vector() -> None:
    assert approval_preimage(REQUEST_ID, "did:key:z6Mkephemeral456").hex() == (
        "000000147370616c2f6469642d617070726f76616c2f7631"
        "0000002436663164326333622d346135652d346636302d386137312d396238326333643465356636"
        "000000186469643a6b65793a7a364d6b657068656d6572616c343536"
    )


def test_an_attestation_fits_no_other_request() -> None:
    with pytest.raises(AttestationInvalid, match="does not prove possession"):
        verify_approval(DID, SIGNATURE, "another-request")


def test_a_signature_by_another_key_does_not_prove_possession_of_the_did() -> None:
    other = Ed25519PrivateKey.generate()
    forged = sign_approval(other, REQUEST_ID, DID)
    with pytest.raises(AttestationInvalid, match="does not prove possession"):
        verify_approval(DID, forged, REQUEST_ID)


def test_a_tampered_signature_is_refused() -> None:
    tampered = bytes([SIGNATURE[0] ^ 1]) + SIGNATURE[1:]
    with pytest.raises(AttestationInvalid):
        verify_approval(DID, tampered, REQUEST_ID)


def test_a_signature_of_the_wrong_length_is_refused_before_any_decoding() -> None:
    with pytest.raises(AttestationInvalid, match="not an Ed25519 signature"):
        verify_approval(DID, SIGNATURE[:-1], REQUEST_ID)


@pytest.mark.parametrize(
    "did",
    [
        "did:web:example.com",
        "did:plc:abcdefghijklmnop",
        "did:key:zInvalid0OIl",  # characters outside base58
        "did:key:z6Mk",  # too short to carry a key
        "did:key:z" + "1" * 48,  # 48 leading zero bytes, no multicodec prefix
        "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme",  # secp256k1 key
    ],
)
def test_only_an_ed25519_did_key_can_prove_possession(did: str) -> None:
    with pytest.raises(AttestationInvalid, match="did:key|Ed25519 key"):
        verify_approval(did, SIGNATURE, REQUEST_ID)


def test_text_the_encoding_rejects_is_refused_not_signed_over() -> None:
    with pytest.raises(AttestationInvalid, match="cannot be encoded"):
        verify_approval(DID, SIGNATURE, "﻿" + REQUEST_ID)
