"""The key a did:key identifier carries, and the identifiers that carry none."""

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from freehold_agent.didkey import NotAnEd25519DidKey, ed25519_public_key
from tests.test_attestation import DID, SEED


def test_the_key_read_from_the_identifier_is_the_key_that_made_it() -> None:
    expected = Ed25519PrivateKey.from_private_bytes(SEED).public_key()
    raw = serialization.Encoding.Raw, serialization.PublicFormat.Raw
    assert ed25519_public_key(DID).public_bytes(*raw) == expected.public_bytes(*raw)


@pytest.mark.parametrize(
    ("did", "reason"),
    [
        ("did:web:example.com", "not a did:key"),
        ("", "not a did:key"),
        ("did:key:zInvalid0OIl", "Ed25519 key"),  # Characters outside base58.
        ("did:key:z6Mk", "Ed25519 key"),  # Too short to carry a key.
        ("did:key:z" + "1" * 48, "Ed25519 key"),  # No multicodec prefix.
        ("did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme", "Ed25519 key"),  # secp256k1.
    ],
)
def test_any_other_identifier_is_refused_with_the_reason(did: str, reason: str) -> None:
    with pytest.raises(NotAnEd25519DidKey, match=reason):
        ed25519_public_key(did)
