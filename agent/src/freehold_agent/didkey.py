"""Reading the key a ``did:key`` identifier carries.

A ``did:key`` is its own key: the identifier is the multicodec-tagged public
key in base58btc, so a verifier needs nothing but the DID. Only the Ed25519
form is read here (multicodec ``0xed01``, the ``z6Mk`` identifiers). A leaf
module, so configuration and the verifiers can all import it.
"""

from __future__ import annotations

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ED25519_SIGNATURE_LENGTH = 64

_DID_KEY_PREFIX = "did:key:z"
_ED25519_MULTICODEC = b"\xed\x01"
_ED25519_KEY_LENGTH = 32
_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_DIGITS = {char: value for value, char in enumerate(_BASE58_ALPHABET)}


class NotAnEd25519DidKey(ValueError):  # noqa: N818
    """The identifier is not the ``did:key`` form of an Ed25519 public key."""


def ed25519_public_key(did: str) -> Ed25519PublicKey:
    """Return the Ed25519 key a ``did:key`` identifier carries.

    Raises:
        NotAnEd25519DidKey: The DID is not a ``did:key``, or does not carry a
            32-byte Ed25519 public key (multicodec ``0xed01``, base58btc,
            ``z`` prefix); the message says which.
    """
    if not did.startswith(_DID_KEY_PREFIX):
        raise NotAnEd25519DidKey("not a did:key, the only kind whose key is in the identifier")
    decoded = _base58_decode(did[len(_DID_KEY_PREFIX) :])
    if (
        decoded is None
        or len(decoded) != len(_ED25519_MULTICODEC) + _ED25519_KEY_LENGTH
        or not decoded.startswith(_ED25519_MULTICODEC)
    ):
        raise NotAnEd25519DidKey("the did:key does not carry an Ed25519 key")
    try:
        return Ed25519PublicKey.from_public_bytes(decoded[len(_ED25519_MULTICODEC) :])
    except ValueError as error:
        raise NotAnEd25519DidKey("the did:key does not carry an Ed25519 key") from error


def _base58_decode(text: str) -> bytes | None:
    """Decode base58btc text; None if any character is outside the alphabet."""
    value = 0
    for char in text:
        digit = _BASE58_DIGITS.get(char)
        if digit is None:
            return None
        value = value * 58 + digit
    leading_zeros = len(text) - len(text.lstrip(_BASE58_ALPHABET[0]))
    body = value.to_bytes((value.bit_length() + 7) // 8, "big") if value else b""
    return b"\x00" * leading_zeros + body
