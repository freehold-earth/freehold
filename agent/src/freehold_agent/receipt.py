"""The terms receipt: an operator's signature for a request it served under terms.

The protocol is ``spec/protocols/terms-receipt.md``. This module is the
holder's side of it: the label a request is sent under (a nonce, and a
commitment to the request that only the holder can open), and the check that
what came back is the one receipt owed for that request. It reads nothing
and writes nothing; the caller sends the label, hands back what arrived, and
keeps what is accepted.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import math
import re
import secrets
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, Literal

from cryptography.exceptions import InvalidSignature
from freehold_preimage import (
    TERMS_RECEIPT,
    FieldKind,
    FixedField,
    TextEncodingError,
    VariableField,
    encode,
    encode_text,
    validate_fields,
)
from freehold_preimage import Field as PreimageField
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from freehold_agent.custody import Operator
from freehold_agent.didkey import ED25519_SIGNATURE_LENGTH, ed25519_public_key
from freehold_agent.errors import ReceiptInvalid, ReceiptRefusal
from freehold_agent.spal import DEFAULT_CUSTODY, Conditions
from freehold_agent.terms import SAFE_INTEGER

_STRUCTURE = TERMS_RECEIPT
_EXPECTED_FIELD_NAMES = (
    "domain_sep",
    "operator_did",
    "terms_hash",
    "nonce",
    "commitment",
    "request_id",
    "served_at",
    "custody",
    "retention_seconds",
    "training",
    "aggregation",
    "resale",
)
if tuple(spec.name for spec in _STRUCTURE.specs) != _EXPECTED_FIELD_NAMES:
    raise ImportError(
        f"registered structure {_STRUCTURE.name} no longer has the field list this module "
        f"encodes; a changed field set needs a new registry entry and a new receipt version"
    )

LABEL: Final = _STRUCTURE.domain_separator
NONCE_LENGTH: Final = 16
SERVED_AT_ALLOWANCE: Final = timedelta(minutes=5)
"""How far a receipt's ``served_at`` may lie before the request was sent or
after its response arrived: room for an operator's clock to differ from the
holder's, and no more."""

REQUEST_ID_MAX_BYTES: Final = 128

_TERMS_HASH = re.compile(r"[0-9a-f]{64}")
_FORBIDDEN: Final = "forbidden"


def request_key(audit_key: bytes, operator_did: str, nonce: bytes) -> bytes:
    """The key one request's commitment is made under, and opened with.

    ``HMAC-SHA256(audit_key, label || 0x00 || operator_did || 0x00 || nonce)``.
    Revealing it opens that one request and no other.

    Args:
        audit_key: The holder's audit key, which never leaves the agent.
        operator_did: The operator the request goes to; empty for none.
        nonce: The 16 bytes minted for the request.

    Returns:
        The 32-byte key.

    Raises:
        ValueError: The DID carries a NUL byte, which would make the
            separators ambiguous, or the nonce is not 16 bytes.
    """
    did = operator_did.encode("utf-8")
    if b"\x00" in did:
        raise ValueError("an operator DID carries no NUL byte")
    if len(nonce) != NONCE_LENGTH:
        raise ValueError(f"a nonce is {NONCE_LENGTH} bytes")
    message = LABEL.encode("utf-8") + b"\x00" + did + b"\x00" + nonce
    return hmac.new(audit_key, message, "sha256").digest()


@dataclass(frozen=True)
class RequestLabel:
    """What one request is sent under: a fresh nonce and a commitment to its bytes.

    ``operator_did`` is who the request goes to; it is empty for a request
    that goes to no operator, which is labelled the same way so that every
    request can be opened alone.
    """

    operator_did: str
    nonce: bytes
    commitment: bytes

    @classmethod
    def mint(cls, audit_key: bytes, operator_did: str, request_bytes: bytes) -> RequestLabel:
        """Label a request about to be sent; each call mints a nonce never used before.

        Args:
            audit_key: The holder's audit key.
            operator_did: The operator the request goes to; empty for none.
            request_bytes: The bytes the transport in use fixes for the request.

        Returns:
            The label to send with the request and to record beside it.

        Raises:
            ValueError: The DID carries a NUL byte.
        """
        nonce = secrets.token_bytes(NONCE_LENGTH)
        key = request_key(audit_key, operator_did, nonce)
        return cls(operator_did, nonce, hmac.new(key, request_bytes, "sha256").digest())


class Receipt(BaseModel):
    """A terms receipt as it travels: one member per field, and the signature.

    Parsing is exact. Hex is lowercase and of its length, an integer is a
    whole number from 0 to 2^53 - 1, each enumerated value is one its field
    allows, the signature is canonical standard base64 of an Ed25519
    signature, the operator's handle is at most 128 bytes of text with no
    control character or line separator in it, and no member is missing or
    unknown. A parsed receipt is
    well-formed and nothing more: whether it is the receipt for a request is
    :meth:`AwaitedReceipt.accept`'s to say.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    operator_did: str
    terms_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    nonce: str = Field(pattern=r"^[0-9a-f]{32}$")
    commitment: str = Field(pattern=r"^[0-9a-f]{64}$")
    request_id: str
    served_at: int = Field(ge=0, le=SAFE_INTEGER)
    custody: Literal[
        "device_only",
        "owned_hardware",
        "community_node",
        "federated_operator",
        "attested_enclave",
        "any",
    ]
    retention_seconds: int = Field(ge=0, le=SAFE_INTEGER)
    training: Literal["forbidden", "allowed", "requires_payment"]
    aggregation: Literal["forbidden", "allowed", "anonymized_only"]
    resale: Literal["forbidden", "allowed", "requires_consent"]
    signature: str

    @field_validator("operator_did", "request_id")
    @classmethod
    def _text_the_encoding_accepts(cls, value: str) -> str:
        try:
            encode_text(value)
        except TextEncodingError as error:
            raise ValueError(str(error)) from error
        return value

    @field_validator("request_id")
    @classmethod
    def _a_short_handle_on_one_line(cls, value: str) -> str:
        """The one free text an operator chooses, bounded: it is kept in the holder's log."""
        if len(value.encode("utf-8")) > REQUEST_ID_MAX_BYTES:
            raise ValueError(f"longer than {REQUEST_ID_MAX_BYTES} bytes")
        if any(unicodedata.category(char) in ("Cc", "Cf", "Zl", "Zp") for char in value):
            raise ValueError("carries a control character or a line separator")
        return value

    @field_validator("signature")
    @classmethod
    def _canonical_base64_of_a_signature(cls, value: str) -> str:
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("not standard base64") from error
        if base64.b64encode(raw).decode("ascii") != value:
            raise ValueError("not canonical base64")
        if len(raw) != ED25519_SIGNATURE_LENGTH:
            raise ValueError("not an Ed25519 signature")
        return value

    def preimage(self) -> bytes:
        """The canonical bytes the operator signs: ``spal/receipt/v1``, signature excluded."""
        values: dict[str, bytes] = {
            "domain_sep": encode_text(LABEL),
            "operator_did": encode_text(self.operator_did),
            "terms_hash": bytes.fromhex(self.terms_hash),
            "nonce": bytes.fromhex(self.nonce),
            "commitment": bytes.fromhex(self.commitment),
            "request_id": encode_text(self.request_id),
            "served_at": self.served_at.to_bytes(8, "big"),
            "custody": encode_text(self.custody),
            "retention_seconds": self.retention_seconds.to_bytes(8, "big"),
            "training": encode_text(self.training),
            "aggregation": encode_text(self.aggregation),
            "resale": encode_text(self.resale),
        }
        ordered = [values[spec.name] for spec in _STRUCTURE.specs]
        validate_fields(_STRUCTURE, ordered)
        fields: list[PreimageField] = []
        for spec, value in zip(_STRUCTURE.specs, ordered, strict=True):
            if spec.kind is FieldKind.VARIABLE:
                fields.append(VariableField(value))
                continue
            if spec.width is None:
                raise ValueError(f"fixed-width field '{spec.name}' has no pinned width")
            fields.append(FixedField(value, spec.width))
        return encode(fields)


class AwaitedReceipt:
    """The one receipt owed for a request sent to an operator under terms.

    Made when the request is sent, from the label it was sent under, the hash
    of the terms sent with it, the conditions of the rule that allowed it,
    and the time of sending. It answers once: the nonce is spent by the first
    thing presented for it, accepted or not, and anything presented after is
    refused.

    The nonce is spent on this object and nowhere else, so exactly one is
    made per request, when it is sent, and held until its response is
    settled. A second one made for the same label would answer again.
    """

    def __init__(
        self,
        label: RequestLabel,
        *,
        terms_hash: str,
        conditions: Conditions,
        sent_at: datetime,
    ) -> None:
        """Await the receipt for a request sent under ``label``.

        Args:
            label: The label the request was sent under; its operator signs.
            terms_hash: The hash of the terms sent with the request.
            conditions: The conditions of the rule that allowed the request.
            sent_at: When the request was sent, by the agent's own clock.

        Raises:
            NotAnEd25519DidKey: The label's operator is not a ``did:key``
                Ed25519 DID, the only signer whose receipt can be checked.
            ValueError: The terms hash is not 64 lowercase hex characters, or
                the time has no timezone.
        """
        if not _TERMS_HASH.fullmatch(terms_hash):
            raise ValueError("a terms hash is 64 lowercase hex characters")
        if sent_at.utcoffset() is None:
            raise ValueError("the time of sending needs a timezone")
        self._operator_key = ed25519_public_key(label.operator_did)
        self._label = label
        self._terms_hash = terms_hash
        self._conditions = conditions
        self._sent_at = sent_at
        self._spent = False

    @property
    def label(self) -> RequestLabel:
        """The label the request was sent under, which the receipt must bear."""
        return self._label

    @property
    def sent_at(self) -> datetime:
        """When the request was sent, the time the served-at window is anchored on."""
        return self._sent_at

    def accept(self, presented: object, *, received_at: datetime) -> Receipt:
        """Check what came back with the response; return it if it is the receipt owed.

        Args:
            presented: The receipt object as the transport delivered it, or
                None when the response carried none.
            received_at: When the response arrived.

        Returns:
            The receipt, parsed and checked.

        Raises:
            ReceiptInvalid: Any check failed; ``refusal`` names the first.
                Nothing is accepted in part, and the nonce stays spent.
            ValueError: ``received_at`` has no timezone.
        """
        if self._spent:
            raise ReceiptInvalid(
                ReceiptRefusal.SPENT, "a receipt was already presented for this request"
            )
        if received_at.utcoffset() is None:
            # The caller's mistake, not a presentation: nothing is spent by it.
            raise ValueError("the time of arrival needs a timezone")
        self._spent = True
        if presented is None:
            raise ReceiptInvalid(ReceiptRefusal.MISSING, "the response carried no receipt")
        receipt = _parse(presented)
        self._check_signer(receipt)
        self._check_request(receipt)
        self._check_served_at(receipt, received_at)
        self._check_conditions(receipt)
        return receipt

    def _check_signer(self, receipt: Receipt) -> None:
        """The receipt is signed as the operator the request went to, by that operator's key."""
        if receipt.operator_did != self._label.operator_did:
            raise ReceiptInvalid(
                ReceiptRefusal.OPERATOR, "signed as an operator the request was not sent to"
            )
        try:
            self._operator_key.verify(base64.b64decode(receipt.signature), receipt.preimage())
        except InvalidSignature as error:
            raise ReceiptInvalid(
                ReceiptRefusal.SIGNATURE, "the signature is not the operator's over this receipt"
            ) from error

    def _check_request(self, receipt: Receipt) -> None:
        """The receipt names the terms, nonce and commitment sent with the request."""
        if not hmac.compare_digest(receipt.terms_hash, self._terms_hash):
            raise ReceiptInvalid(ReceiptRefusal.TERMS, "not the terms sent with the request")
        if not hmac.compare_digest(receipt.nonce, self._label.nonce.hex()):
            raise ReceiptInvalid(ReceiptRefusal.NONCE, "not the nonce sent with the request")
        if not hmac.compare_digest(receipt.commitment, self._label.commitment.hex()):
            raise ReceiptInvalid(
                ReceiptRefusal.COMMITMENT, "not the commitment sent with the request"
            )

    def _check_served_at(self, receipt: Receipt, received_at: datetime) -> None:
        """The served time lies within the allowance around sending and arrival."""
        # served_at is in whole seconds; each bound rounds outward to the second it falls in.
        earliest = math.floor((self._sent_at - SERVED_AT_ALLOWANCE).timestamp())
        latest = math.ceil((received_at + SERVED_AT_ALLOWANCE).timestamp())
        if not earliest <= receipt.served_at <= latest:
            raise ReceiptInvalid(
                ReceiptRefusal.SERVED_AT,
                "served outside the time the request was sent and answered in",
            )

    def _check_conditions(self, receipt: Receipt) -> None:
        """The operator's conditions are no weaker than the rule's.

        Custody always binds, a silent rule meaning ``owned_hardware``.
        Retention and derivatives bind where the rule states them; a
        derivative value satisfies the rule only by equalling it or being
        ``forbidden``.
        """
        rule = self._conditions
        ceiling = (rule.custody or DEFAULT_CUSTODY).operator
        if Operator(receipt.custody).rank > ceiling.rank:
            raise ReceiptInvalid(
                ReceiptRefusal.CONDITIONS,
                f"custody: served at {receipt.custody}, beyond the rule's {ceiling.value}",
            )
        if rule.retention is not None and receipt.retention_seconds > rule.retention.max_seconds:
            raise ReceiptInvalid(
                ReceiptRefusal.CONDITIONS,
                f"retention: {receipt.retention_seconds} seconds, above the rule's "
                f"{rule.retention.max_seconds}",
            )
        if rule.derivatives is None:
            return
        for name in ("training", "aggregation", "resale"):
            committed, asked = getattr(receipt, name), getattr(rule.derivatives, name).value
            if committed not in (asked, _FORBIDDEN):
                raise ReceiptInvalid(
                    ReceiptRefusal.CONDITIONS,
                    f"derivatives: {name} is {committed}, where the rule says {asked}",
                )


def _parse(presented: object) -> Receipt:
    """The receipt object as a :class:`Receipt`, or refused as malformed.

    The detail names the member and the fault and carries nothing of what
    was presented: not a value, and not the name of a member the receipt
    does not have, which is the presenter's text too.
    """
    try:
        return Receipt.model_validate(presented)
    except ValidationError as error:
        first = error.errors(include_input=False, include_url=False)[0]
        if first["type"] == "extra_forbidden":
            detail = "a member the receipt does not have"
        else:
            member = first["loc"][0] if first["loc"] else "receipt"
            detail = f"{member}: {first['msg']}"
        raise ReceiptInvalid(ReceiptRefusal.MALFORMED, detail) from error
