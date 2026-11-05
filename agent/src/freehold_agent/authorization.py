"""The vault's root-signed authorization records, verified here.

An ephemeral DID is the user's because the root key signed an authorization
record for it (identity package, ``spal/did-authorization/v2``). The record
and the root key both live in the user's vault, so the agent can rebuild the
record's canonical preimage from its stored fields with the reference
encoder and check the signature with the key the vault holds. A DID with no
such record is not one this vault's owner issued, whoever holds its key.

Checking against the stored key, not the root DID, means a root that is not
a ``did:key`` (an atproto account bound to a local key) needs no resolution
here: the record must have been signed by the key this vault keeps, which is
what proves it is the owner's.

The preimage follows the identity package field for field. ``metadata`` is
carried as RFC 8785 canonical JSON; the subset of JSON this module
canonicalises is what a stored record can carry (text, integers, booleans,
null, arrays, objects). A non-integer number has an ECMAScript spelling this
module does not reproduce, so a record with one is refused rather than
signed over different bytes.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Final

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from freehold_preimage import (
    DID_AUTHORIZATION_RECORD,
    TextEncodingError,
    VariableField,
    encode,
    encode_text,
)

from freehold_agent.errors import AuthorizationInvalid

_STRUCTURE = DID_AUTHORIZATION_RECORD
_EXPECTED_FIELD_NAMES = (
    "domain_sep",
    "ephemeral_did",
    "root_did",
    "purpose",
    "verification_type",
    "verifier_did",
    "policy_hash",
    "metadata",
    "issued_at",
    "expires_at",
    "root_key_id",
)
if tuple(spec.name for spec in _STRUCTURE.specs) != _EXPECTED_FIELD_NAMES:
    raise ImportError(
        f"registered structure {_STRUCTURE.name} no longer has the field list this module "
        f"encodes; a changed field set needs a new registry entry and a new record version"
    )

DOMAIN_SEPARATOR = _STRUCTURE.domain_separator
SIGNED_CONTEXT_KEYS: Final = frozenset(
    {"verificationType", "verifierDid", "policyHash", "metadata"}
)
_ED25519_SIGNATURE_LENGTH = 64
_MAX_SAFE_INTEGER = 2**53 - 1


def canonical_json(value: object) -> str:
    """Serialise JSON data in its RFC 8785 canonical form.

    Object keys sorted by UTF-16 code units, no whitespace, strings escaped
    as ECMAScript's ``JSON.stringify`` does. Integers (and integral floats,
    which JSON parses as the same number) print plainly up to 2^53 - 1.

    Raises:
        ValueError: The value is not JSON data this module can canonicalise:
            a non-integral or out-of-range number, text that is not
            well-formed Unicode, or a Python type JSON has no form for.
    """
    if value is None or value is True or value is False:
        return json.dumps(value)
    if isinstance(value, int):
        if abs(value) > _MAX_SAFE_INTEGER:
            raise ValueError("canonical JSON cannot represent an integer beyond 2^53 - 1")
        return str(value)
    if isinstance(value, float):
        if not value.is_integer() or abs(value) > _MAX_SAFE_INTEGER:
            raise ValueError("canonical JSON cannot represent a non-integer number here")
        return str(int(value))
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        members = []
        for key in sorted(value, key=_utf16_order):
            if not isinstance(key, str):
                raise ValueError("canonical JSON object keys must be text")
            members.append(f"{_json_string(key)}:{canonical_json(value[key])}")
        return "{" + ",".join(members) + "}"
    raise ValueError(f"canonical JSON cannot represent {type(value).__name__}")


def _json_string(text: str) -> str:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("canonical JSON strings must be well-formed Unicode") from error
    return json.dumps(text, ensure_ascii=False)


def _utf16_order(key: object) -> bytes:
    return key.encode("utf-16-be", "surrogatepass") if isinstance(key, str) else b""


def authorization_preimage(record: Mapping[str, object]) -> bytes:
    """Return the canonical bytes a root key signs for a stored authorization record.

    The record is in its stored (JSON) form: ``ephemeralDid``, ``rootDid``,
    ``purpose``, ``context`` (``verificationType`` and the optional
    ``verifierDid``, ``policyHash`` and ``metadata``), ``timestamp`` and the
    optional ``expiresAt`` and ``rootKeyId``. An absent optional field is an
    empty text field; ``metadata`` is also empty when null.

    Raises:
        AuthorizationInvalid: A required field is missing or not text, the
            context carries a key the signature does not cover, or a value
            cannot be encoded as the specification's text field.
    """
    context = record.get("context")
    if not isinstance(context, Mapping):
        raise AuthorizationInvalid("authorization record has no context")
    unsigned = set(context) - SIGNED_CONTEXT_KEYS
    if unsigned:
        raise AuthorizationInvalid(
            "authorization record context carries keys the signature does not cover: "
            + ", ".join(sorted(map(str, unsigned)))
        )
    metadata = context.get("metadata")
    try:
        metadata_text = "" if metadata is None else canonical_json(metadata)
    except ValueError as error:
        raise AuthorizationInvalid(f"authorization record metadata: {error}") from error
    values = [
        DOMAIN_SEPARATOR,
        _text(record, "ephemeralDid"),
        _text(record, "rootDid"),
        _text(record, "purpose"),
        _text(context, "verificationType"),
        _optional_text(context, "verifierDid"),
        _optional_text(context, "policyHash"),
        metadata_text,
        _text(record, "timestamp"),
        _optional_text(record, "expiresAt"),
        _optional_text(record, "rootKeyId"),
    ]
    try:
        return encode([VariableField(encode_text(value)) for value in values])
    except TextEncodingError as error:
        raise AuthorizationInvalid(f"authorization record cannot be encoded: {error}") from error


def _text(source: Mapping[str, object], name: str) -> str:
    value = source.get(name)
    if not isinstance(value, str):
        raise AuthorizationInvalid(f"authorization record field {name} must be text")
    return value


def _optional_text(source: Mapping[str, object], name: str) -> str:
    return "" if name not in source else _text(source, name)


def verify_authorization_record(
    record: Mapping[str, object],
    root_did: str,
    root_public_key: bytes,
    *,
    now: datetime | None = None,
) -> None:
    """Check that the vault's root issued the ephemeral DID this record names.

    Args:
        record: The authorization record in its stored form, with
            ``rootSignature`` as a list of byte values.
        root_did: The vault's root DID, which the record must name as its root.
        root_public_key: The vault's root Ed25519 public key, 32 bytes.
        now: The moment to judge expiry at; the current time by default.

    Raises:
        AuthorizationInvalid: The record names another root, has expired or
            has an expiry that does not parse, is malformed, or its signature
            does not verify under the root key.
    """
    if record.get("rootDid") != root_did:
        raise AuthorizationInvalid("authorization record was not issued by this vault's root")
    _check_not_expired(record, now or datetime.now(UTC))
    signature = record.get("rootSignature")
    if (
        not isinstance(signature, list)
        or len(signature) != _ED25519_SIGNATURE_LENGTH
        or not all(isinstance(b, int) and 0 <= b <= 255 for b in signature)
    ):
        raise AuthorizationInvalid("authorization record signature is not an Ed25519 signature")
    preimage = authorization_preimage(record)
    try:
        Ed25519PublicKey.from_public_bytes(root_public_key).verify(bytes(signature), preimage)
    except ValueError as error:
        raise AuthorizationInvalid("the vault's root key is not an Ed25519 key") from error
    except InvalidSignature as error:
        raise AuthorizationInvalid(
            "authorization record signature does not verify under the vault's root key"
        ) from error


def _check_not_expired(record: Mapping[str, object], now: datetime) -> None:
    expires_at = record.get("expiresAt")
    if expires_at is None:
        return
    if not isinstance(expires_at, str):
        raise AuthorizationInvalid("authorization record expiry is not text")
    try:
        expiry = datetime.fromisoformat(expires_at)
    except ValueError as error:
        raise AuthorizationInvalid("authorization record expiry does not parse") from error
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=UTC)
    if expiry < now:
        raise AuthorizationInvalid("authorization record has expired")
