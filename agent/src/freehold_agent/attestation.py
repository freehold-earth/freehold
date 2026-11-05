"""Proof of possession for the ephemeral DID an approval names.

An approval may name the ephemeral DID the user's app issued for a
verification, and the proof then names it too. On its own that is an
assertion: the approve endpoint is unauthenticated, so any caller could name
any DID. What makes it the holder's is the attestation the app signs with
that DID's key over the ``spal/did-approval/v1`` preimage (the request id and
the DID), which this module checks. The verifying key is read from the DID
itself, so only a ``did:key`` Ed25519 DID can be checked; any other DID is
refused rather than taken on trust.

The request id is the attestation's whole context: it is minted here as a
random UUID, so an attestation for one request fits no other, and it is
never taken from the caller.
"""

from __future__ import annotations

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from freehold_preimage import (
    DID_APPROVAL_ATTESTATION,
    TextEncodingError,
    VariableField,
    encode,
    encode_text,
)

from freehold_agent.errors import AttestationInvalid

_STRUCTURE = DID_APPROVAL_ATTESTATION
_EXPECTED_FIELD_NAMES = ("domain_sep", "request_id", "requester_did")
if tuple(spec.name for spec in _STRUCTURE.specs) != _EXPECTED_FIELD_NAMES:
    raise ImportError(
        f"registered structure {_STRUCTURE.name} no longer has the field list this module "
        f"encodes; a changed field set needs a new registry entry and a new attestation version"
    )

DOMAIN_SEPARATOR = _STRUCTURE.domain_separator
_DID_KEY_PREFIX = "did:key:z"
_ED25519_MULTICODEC = b"\xed\x01"
_ED25519_KEY_LENGTH = 32
_ED25519_SIGNATURE_LENGTH = 64
_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_DIGITS = {char: value for value, char in enumerate(_BASE58_ALPHABET)}


def approval_preimage(request_id: str, requester_did: str) -> bytes:
    """Return the canonical bytes an approval attestation signs.

    Each value is a text field under the preimage specification's text-field
    rule (UTF-8 as given, well-formed, no byte-order mark), length-prefixed
    after the domain separator; any implementation of the spec reproduces
    the same bytes from the same two strings.

    Args:
        request_id: The verification request being approved, as issued here.
        requester_did: The ephemeral DID whose key signs.

    Raises:
        TextEncodingError: Either value is not text the encoding accepts.
    """
    return encode(
        [
            VariableField(encode_text(DOMAIN_SEPARATOR)),
            VariableField(encode_text(request_id)),
            VariableField(encode_text(requester_did)),
        ]
    )


def verify_approval(requester_did: str, signature: bytes, request_id: str) -> None:
    """Check that the signature proves possession of the DID's key for this request.

    Args:
        requester_did: The DID the approval names; must be a ``did:key``
            Ed25519 DID, the only kind whose key the identifier carries.
        signature: The Ed25519 signature over the approval preimage.
        request_id: The request the approval is for, as this agent issued it.

    Raises:
        AttestationInvalid: The DID is not one that can be checked here, the
            signature is not an Ed25519 signature, or it does not verify over
            this request and DID under the DID's key.
    """
    public_key = _did_key_public_key(requester_did)
    if len(signature) != _ED25519_SIGNATURE_LENGTH:
        raise AttestationInvalid("the approval's signature is not an Ed25519 signature")
    try:
        preimage = approval_preimage(request_id, requester_did)
    except TextEncodingError as error:
        raise AttestationInvalid(f"the approval cannot be encoded for signing: {error}") from error
    try:
        public_key.verify(signature, preimage)
    except InvalidSignature as error:
        raise AttestationInvalid(
            "the approval's signature does not prove possession of the requester DID"
        ) from error


def _did_key_public_key(did: str) -> Ed25519PublicKey:
    """Return the Ed25519 key a ``did:key`` identifier carries.

    Raises:
        AttestationInvalid: The DID is not the ``did:key`` form of a 32-byte
            Ed25519 public key (multicodec ``0xed01``, base58btc, ``z`` prefix).
    """
    if not did.startswith(_DID_KEY_PREFIX):
        raise AttestationInvalid(
            "only a did:key requester can prove possession; its key is in the identifier"
        )
    decoded = _base58_decode(did[len(_DID_KEY_PREFIX) :])
    if (
        decoded is None
        or len(decoded) != len(_ED25519_MULTICODEC) + _ED25519_KEY_LENGTH
        or not decoded.startswith(_ED25519_MULTICODEC)
    ):
        raise AttestationInvalid("the requester DID does not carry an Ed25519 key")
    try:
        return Ed25519PublicKey.from_public_bytes(decoded[len(_ED25519_MULTICODEC) :])
    except ValueError as error:
        raise AttestationInvalid("the requester DID does not carry an Ed25519 key") from error


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
