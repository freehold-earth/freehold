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
carried as RFC 8785 canonical JSON, numbers spelled as ECMAScript spells
them; an integer beyond 2^53 - 1, which JavaScript could not have held
exactly, is refused rather than guessed at.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
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
from freehold_agent.seams import ContextReader

ROOT_IDENTITY_KEY = "root-identity"
"""The vault entry holding the root identity: its DID and serialized keypair."""

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

logger = logging.getLogger(__name__)

DOMAIN_SEPARATOR = _STRUCTURE.domain_separator
SIGNED_CONTEXT_KEYS: Final = frozenset(
    {"verificationType", "verifierDid", "policyHash", "metadata"}
)
_ED25519_SIGNATURE_LENGTH = 64
_ED25519_KEY_LENGTH = 32
_MAX_SAFE_INTEGER = 2**53 - 1
# The identity package writes expiries with Date.toISOString(); only that
# form is read here, so both sides parse the same strings the same way.
_ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")


def canonical_json(value: object) -> str:
    """Serialise JSON data in its RFC 8785 canonical form.

    Object keys sorted by UTF-16 code units, no whitespace, strings escaped
    as ECMAScript's ``JSON.stringify`` does, numbers as ECMAScript's
    ``Number::toString`` spells them (shortest round-trip digits, exponent
    form outside 1e-6 to 1e21). An integer beyond 2^53 - 1 is refused: a
    JavaScript writer could not have held it exactly, so no spelling here
    can be known to match the one it signed.

    Args:
        value: JSON data: text, an integer, a boolean, None, a list or a
            mapping with text keys, nested as JSON allows.

    Returns:
        The one canonical text for that data.

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
        if not math.isfinite(value):
            raise ValueError("canonical JSON cannot represent a non-finite number")
        return _es_number(value)
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("canonical JSON object keys must be text")
        members = [
            f"{_json_string(key)}:{canonical_json(value[key])}"
            for key in sorted(value, key=_utf16_order)
        ]
        return "{" + ",".join(members) + "}"
    raise ValueError(f"canonical JSON cannot represent {type(value).__name__}")


def _es_number(value: float) -> str:
    """Spell a finite number as ECMAScript's Number::toString(10) does.

    The shortest digits that round-trip (which Python's repr also finds)
    laid out by ECMA-262's rules: plain digits up to 1e21, a leading "0."
    down to 1e-6, and exponent form with a signed exponent beyond those.
    """
    if value == 0:
        return "0"  # Both zeros; JSON.stringify(-0) is "0" too.
    sign = "-" if value < 0 else ""
    digits_tuple, exponent = Decimal(repr(abs(value))).normalize().as_tuple()[1:]
    digits = "".join(map(str, digits_tuple))
    k = len(digits)
    n = int(exponent) + k  # value = 0.<digits> × 10^n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + digits
    mantissa = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
    return f"{sign}{mantissa}e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"


def _json_string(text: str) -> str:
    """JSON-quote text as JSON.stringify does; well-formed Unicode only."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("canonical JSON strings must be well-formed Unicode") from error
    return json.dumps(text, ensure_ascii=False)


def _utf16_order(key: str) -> bytes:
    """Sort key giving the UTF-16 code unit order JavaScript sorts object keys in."""
    return key.encode("utf-16-be", "surrogatepass")


def authorization_preimage(record: Mapping[str, object]) -> bytes:
    """Return the canonical bytes a root key signs for a stored authorization record.

    The record is in its stored (JSON) form: ``ephemeralDid``, ``rootDid``,
    ``purpose``, ``context`` (``verificationType`` and the optional
    ``verifierDid``, ``policyHash`` and ``metadata``), ``timestamp`` and the
    optional ``expiresAt`` and ``rootKeyId``. An absent optional field is an
    empty text field; ``metadata`` is also empty when null.

    Args:
        record: The record as stored, with or without its ``rootSignature``.

    Returns:
        The canonical ``spal/did-authorization/v2`` encoding of its fields.

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
    except RecursionError as error:
        raise AuthorizationInvalid("authorization record metadata is nested too deep") from error
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
    """A required text field, or AuthorizationInvalid naming it."""
    value = source.get(name)
    if not isinstance(value, str):
        raise AuthorizationInvalid(f"authorization record field {name} must be text")
    return value


def _optional_text(source: Mapping[str, object], name: str) -> str:
    """An optional text field: empty when absent, invalid when present and not text."""
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

    What this checks is that the vault's root issued the DID, nothing about
    which request or business the record was issued for; binding the DID to
    one request is the holder's approval attestation's job. As in the
    identity package, a record whose root is a ``did:key`` names no key
    binding, so one carrying ``rootKeyId`` is not a record that layer issued.

    Raises:
        AuthorizationInvalid: The record names another root, has expired or
            has an expiry that does not parse, is malformed, or its signature
            does not verify under the root key.
    """
    if record.get("rootDid") != root_did:
        raise AuthorizationInvalid("authorization record was not issued by this vault's root")
    if not _is_external_root(root_did) and "rootKeyId" in record:
        raise AuthorizationInvalid("authorization record names a key binding for a did:key root")
    moment = now or datetime.now(UTC)
    _check_not_expired(record, moment if moment.tzinfo else moment.replace(tzinfo=UTC))
    signature = _byte_list(record.get("rootSignature"), _ED25519_SIGNATURE_LENGTH)
    if signature is None:
        raise AuthorizationInvalid("authorization record signature is not an Ed25519 signature")
    preimage = authorization_preimage(record)
    try:
        Ed25519PublicKey.from_public_bytes(root_public_key).verify(signature, preimage)
    except ValueError as error:
        raise AuthorizationInvalid("the vault's root key is not an Ed25519 key") from error
    except InvalidSignature as error:
        raise AuthorizationInvalid(
            "authorization record signature does not verify under the vault's root key"
        ) from error


def _is_external_root(did: str) -> bool:
    """Whether a root DID is an atproto account bound to a local key, as identity decides."""
    return did.startswith(("did:plc:", "did:web:"))


def _byte_list(value: object, length: int) -> bytes | None:
    """The bytes a stored list of byte values holds, or None unless it is exactly that long."""
    # bool is an int in Python; a true/false in a stored byte list is not a byte.
    if (
        not isinstance(value, list)
        or len(value) != length
        or not all(type(b) is int and 0 <= b <= 255 for b in value)
    ):
        return None
    return bytes(value)


def _check_not_expired(record: Mapping[str, object], now: datetime) -> None:
    """Refuse an expired record. An absent expiry is none; any present value must be
    a ``Date.toISOString()`` instant, the one form the identity package writes."""
    if "expiresAt" not in record:
        return
    expires_at = record["expiresAt"]
    if not isinstance(expires_at, str) or not _ISO_INSTANT.match(expires_at):
        raise AuthorizationInvalid("authorization record expiry does not parse")
    try:
        expiry = datetime.fromisoformat(expires_at)
    except ValueError as error:  # The shape is right but the date is not on any calendar.
        raise AuthorizationInvalid("authorization record expiry does not parse") from error
    if expiry < now:
        raise AuthorizationInvalid("authorization record has expired")


async def root_issued(vault: ContextReader, requester_did: str, record_key: str) -> None:
    """Check that the unlocked vault's root issued ``requester_did``.

    Reads the root identity entry and the record under ``record_key``, and
    passes if that record names the DID and verifies under the root's key.
    Two reads, two decryptions; the vault is never searched.

    Args:
        vault: The unlocked vault.
        requester_did: The ephemeral DID the approval names.
        record_key: Where the app kept the record for that DID.

    Raises:
        AuthorizationInvalid: The vault holds no root identity, nothing at
            the key, a record for another DID, or one that does not verify.
        ContextUnavailable: The vault is locked or cannot be read, as the
            reader raises it.
    """
    root_entry = await vault.entry(ROOT_IDENTITY_KEY)
    root = root_entry.data if root_entry is not None else None
    if not isinstance(root, Mapping):
        raise AuthorizationInvalid("the vault holds no root identity")
    root_did = root.get("did")
    public_key = _byte_list(root.get("publicKey"), _ED25519_KEY_LENGTH)
    if not isinstance(root_did, str) or public_key is None:
        raise AuthorizationInvalid("the vault's root identity is malformed")
    named = await vault.entry(record_key)
    if named is None:
        raise AuthorizationInvalid("the vault holds nothing at the named record key")
    record = named.data
    if not isinstance(record, Mapping) or record.get("ephemeralDid") != requester_did:
        raise AuthorizationInvalid("the record at the named key is not for this DID")
    verify_authorization_record(record, root_did, public_key)
