"""DID-signed request envelopes for agent-to-agent requests.

An envelope names the sender, recipient, action and related policy of a
request, binds them to a nonce, a validity window and a digest of the request
payload, and is signed by the sender. The signed preimage is the canonical
injective, domain-separated encoding of the ``PCI/did-envelope/v1`` structure
from the preimage-encoding specification, so no re-partitioning of the
variable-length identifiers can produce a second envelope that the same
signature authorizes.

The signature scheme is deliberately not fixed here: the digest, key type and
DID resolution belong to the identity layer and are supplied through the
signer and verifier protocols.

The models' JSON form encodes byte fields as base64. That is a transport
convenience only; the signed preimage is always the canonical binary encoding
and never depends on how an envelope travels.
"""

from __future__ import annotations

import hmac
import secrets
import time
from typing import Protocol

from freehold_preimage import (
    DID_SIGNED_REQUEST_ENVELOPE,
    FieldKind,
    FixedField,
    VariableField,
    encode,
)
from freehold_preimage import Field as PreimageField
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from pci_agent.errors import (
    EnvelopeBodyMismatch,
    EnvelopeExpired,
    EnvelopeLifetimeExceeded,
    EnvelopeMisaddressed,
    EnvelopeNotYetValid,
    EnvelopeReplayed,
    EnvelopeSignatureInvalid,
)

_STRUCTURE = DID_SIGNED_REQUEST_ENVELOPE
_EXPECTED_FIELD_NAMES = (
    "domain_sep",
    "sender_did",
    "recipient_did",
    "action",
    "policy_id",
    "nonce",
    "issued_at",
    "expires_at",
    "body_hash",
)
if tuple(spec.name for spec in _STRUCTURE.specs) != _EXPECTED_FIELD_NAMES:
    raise ImportError(
        f"registered structure {_STRUCTURE.name} no longer has the field list this module "
        f"encodes; a changed field set needs a new registry entry and a new envelope version"
    )


def _pinned_width(name: str) -> int:
    """Return the width the envelope structure pins for a fixed-width field.

    Raises:
        ValueError: The structure has no field of that name, or the field is
            not fixed-width, either of which would make the constants derived
            from it meaningless.
    """
    spec = next((s for s in _STRUCTURE.specs if s.name == name), None)
    if spec is None:
        raise ValueError(f"{_STRUCTURE.name} has no field '{name}'")
    if spec.width is None:
        raise ValueError(f"field '{name}' is not fixed-width in {_STRUCTURE.name}")
    return spec.width


def _unsigned_max(name: str) -> int:
    return (1 << (8 * _pinned_width(name))) - 1


DOMAIN_SEPARATOR = _STRUCTURE.domain_separator
NONCE_WIDTH = _pinned_width("nonce")
BODY_HASH_WIDTH = _pinned_width("body_hash")
DEFAULT_LEEWAY_SECONDS = 30
DEFAULT_MAX_LIFETIME_SECONDS = 3600

# Upper bounds for untrusted variable-length input. The encoding itself allows
# up to 2^32 - 1 bytes per field; these are the sizes a request may reasonably
# carry, so an oversized envelope is rejected before it is encoded or hashed.
MAX_DID_LENGTH = 2048
MAX_ACTION_LENGTH = 128
MAX_POLICY_ID_LENGTH = 512
MAX_SIGNATURE_LENGTH = 4096

_BYTES_AS_BASE64 = ConfigDict(
    frozen=True, strict=True, ser_json_bytes="base64", val_json_bytes="base64"
)


class RequestEnvelope(BaseModel):
    """The fields an agent commits to when it signs a request.

    Bytes fields are accepted only as bytes and at the exact width the
    structure pins; timestamps are unix seconds that must fit the structure's
    unsigned 64-bit field; text fields are bounded and must be UTF-8 encodable.
    """

    model_config = _BYTES_AS_BASE64

    sender_did: str = Field(min_length=1, max_length=MAX_DID_LENGTH)
    recipient_did: str = Field(min_length=1, max_length=MAX_DID_LENGTH)
    action: str = Field(min_length=1, max_length=MAX_ACTION_LENGTH)
    policy_id: str = Field(default="", max_length=MAX_POLICY_ID_LENGTH)
    nonce: bytes = Field(min_length=NONCE_WIDTH, max_length=NONCE_WIDTH)
    issued_at: int = Field(ge=0, le=_unsigned_max("issued_at"))
    expires_at: int = Field(ge=0, le=_unsigned_max("expires_at"))
    body_hash: bytes = Field(min_length=BODY_HASH_WIDTH, max_length=BODY_HASH_WIDTH)

    @field_validator("sender_did", "recipient_did", "action", "policy_id")
    @classmethod
    def _utf8_encodable(cls, value: str) -> str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("field must be encodable as UTF-8") from error
        return value

    @model_validator(mode="after")
    def _expiry_follows_issue(self) -> RequestEnvelope:
        if self.expires_at <= self.issued_at:
            raise ValueError("expires_at must be later than issued_at")
        return self

    def preimage(self) -> bytes:
        """Return the canonical injective encoding of this envelope.

        This is the byte string a signature scheme signs. The domain separator
        is the first field; every variable-length field is length-prefixed and
        every fixed-width field is emitted at its pinned width. Values are
        bound to the structure's fields by name, so a field-order change in
        the registered structure can never transpose two values silently.
        """
        values: dict[str, bytes | int] = {
            "domain_sep": DOMAIN_SEPARATOR.encode("utf-8"),
            "sender_did": self.sender_did.encode("utf-8"),
            "recipient_did": self.recipient_did.encode("utf-8"),
            "action": self.action.encode("utf-8"),
            "policy_id": self.policy_id.encode("utf-8"),
            "nonce": self.nonce,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "body_hash": self.body_hash,
        }
        fields: list[PreimageField] = []
        for spec in _STRUCTURE.specs:
            value = values[spec.name]
            if spec.kind is FieldKind.VARIABLE:
                if not isinstance(value, bytes):
                    raise TypeError(f"variable-length field '{spec.name}' must be bytes")
                fields.append(VariableField(value))
                continue
            if spec.width is None:
                raise ValueError(f"fixed-width field '{spec.name}' has no pinned width")
            raw = value.to_bytes(spec.width, "big") if isinstance(value, int) else value
            fields.append(FixedField(raw, spec.width))
        return encode(fields)


class SignedEnvelope(BaseModel):
    """An envelope together with its sender's signature over the envelope preimage."""

    model_config = _BYTES_AS_BASE64

    envelope: RequestEnvelope
    signature: bytes = Field(min_length=1, max_length=MAX_SIGNATURE_LENGTH)


class EnvelopeSigner(Protocol):
    """Signs envelope preimages on behalf of one DID."""

    @property
    def did(self) -> str:
        """The DID whose key this signer holds."""
        ...

    def sign(self, preimage: bytes) -> bytes:
        """Return a signature over the preimage under this signer's DID key."""
        ...


class EnvelopeVerifier(Protocol):
    """Checks signatures against the key material a DID resolves to.

    Implementations must compare signatures in constant time and must return
    ``False``, not raise, for a DID they cannot resolve.
    """

    def verify(self, did: str, preimage: bytes, signature: bytes) -> bool:
        """Return whether the signature over the preimage is valid for the DID."""
        ...


class NonceStore(Protocol):
    """Records nonces a recipient has accepted, so each is honored once.

    Implementations must make the claim atomic with respect to concurrent
    claims of the same nonce, and may forget a nonce once its envelope's
    expiry time, plus any leeway the verifier applies, has passed.
    """

    def claim(self, sender_did: str, nonce: bytes, expires_at: int) -> bool:
        """Record the nonce and return ``True`` if it had not been claimed before."""
        ...


def new_nonce() -> bytes:
    """Return a fresh random nonce of the width the envelope structure pins."""
    return secrets.token_bytes(NONCE_WIDTH)


def sign_envelope(envelope: RequestEnvelope, signer: EnvelopeSigner) -> SignedEnvelope:
    """Sign an envelope with the key of its sender.

    Args:
        envelope: The envelope to sign.
        signer: Holds the key of the envelope's sender.

    Returns:
        The envelope paired with the signer's signature over its preimage.

    Raises:
        ValueError: The signer's DID is not the envelope's sender. Signing is
            a local operation, so this is a caller programming error and is
            deliberately outside the service error hierarchy.
    """
    if signer.did != envelope.sender_did:
        raise ValueError("signer DID must match the envelope sender")
    return SignedEnvelope(envelope=envelope, signature=signer.sign(envelope.preimage()))


def verify_envelope(
    signed: SignedEnvelope,
    verifier: EnvelopeVerifier,
    *,
    recipient_did: str,
    expected_body_hash: bytes,
    nonce_store: NonceStore,
    now: int | None = None,
    leeway: int = DEFAULT_LEEWAY_SECONDS,
    max_lifetime: int = DEFAULT_MAX_LIFETIME_SECONDS,
) -> None:
    """Check every property a recipient relies on before acting on an envelope.

    The cheap checks run first so that a misaddressed, expired, over-long or
    body-mismatched envelope never triggers DID resolution or signature
    verification, and the nonce is claimed only after the signature verifies,
    so a forged envelope cannot burn a nonce the real sender has yet to use.

    Args:
        signed: The envelope and signature under test.
        verifier: Resolves the sender DID and checks the signature.
        recipient_did: The DID of the service performing the verification.
        expected_body_hash: Digest of the payload actually delivered with the
            envelope, as the recipient computed it.
        nonce_store: Where accepted nonces are recorded for replay protection.
        now: Unix seconds to evaluate the validity window at; defaults to the
            current time.
        leeway: Seconds of clock skew tolerated at both ends of the window.
        max_lifetime: Longest declared validity window, in seconds, the
            verifier accepts. With leeway, the effective acceptance window is
            ``max_lifetime + 2 * leeway``.

    Raises:
        ValueError: ``leeway`` or ``max_lifetime`` is negative. This is a
            verifier configuration error, not an envelope fault.
        EnvelopeMisaddressed: The envelope names a different recipient.
        EnvelopeLifetimeExceeded: The window is longer than ``max_lifetime``.
        EnvelopeNotYetValid: ``now`` is before the issue time, beyond leeway.
        EnvelopeExpired: ``now`` is at or after the expiry time, beyond leeway.
        EnvelopeBodyMismatch: The envelope's body hash is not the digest of
            the delivered payload.
        EnvelopeSignatureInvalid: The signature does not verify for the sender.
        EnvelopeReplayed: The nonce was already accepted from this sender.
    """
    if leeway < 0:
        raise ValueError("leeway must not be negative")
    if max_lifetime < 0:
        raise ValueError("max_lifetime must not be negative")
    envelope = signed.envelope
    if envelope.recipient_did != recipient_did:
        raise EnvelopeMisaddressed("envelope is addressed to a different recipient")
    if envelope.expires_at - envelope.issued_at > max_lifetime:
        raise EnvelopeLifetimeExceeded("envelope validity window exceeds the allowed lifetime")
    moment = int(time.time()) if now is None else now
    if moment + leeway < envelope.issued_at:
        raise EnvelopeNotYetValid("envelope presented before its issue time")
    if moment - leeway >= envelope.expires_at:
        raise EnvelopeExpired("envelope presented at or after its expiry time")
    if not hmac.compare_digest(envelope.body_hash, expected_body_hash):
        raise EnvelopeBodyMismatch("envelope body hash does not match the delivered payload")
    if not verifier.verify(envelope.sender_did, envelope.preimage(), signed.signature):
        raise EnvelopeSignatureInvalid("envelope signature does not verify for its sender")
    if not nonce_store.claim(envelope.sender_did, envelope.nonce, envelope.expires_at):
        raise EnvelopeReplayed("envelope nonce was already accepted from this sender")
