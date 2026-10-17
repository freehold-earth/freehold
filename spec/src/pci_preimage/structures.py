"""Registered preimage structures, their normative field schemas, and field grammars.

Mirrors the "Structures in Scope" section of ``protocols/preimage-encoding.md``.
Field order is normative; the domain-separator strings are the registry entries
and must be used verbatim. A few fields carry an internal grammar that the
kind-and-width schema cannot express; those rules are enforced here.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

from pci_preimage.encoding import FieldKind, FieldSpec, PreimageError

CARDANO_POLICY_ID_WIDTH = 28
CARDANO_MAX_ASSET_NAME_LENGTH = 32


class CurrencyError(PreimageError):
    """A settlement currency field's internal layout violates the currency registry."""


class CurrencyTag(Enum):
    """First byte of a settlement currency field, fixing the layout of the rest."""

    SATS = 0x01
    LOVELACE = 0x02
    USD_CENTS = 0x03
    CARDANO_NATIVE = 0x04


@dataclass(frozen=True)
class Structure:
    """A registered preimage structure: its name, domain separator, and field schema."""

    name: str
    domain_separator: str
    specs: tuple[FieldSpec, ...]


def _var(name: str) -> FieldSpec:
    return FieldSpec(name, FieldKind.VARIABLE)


def _fixed(name: str, width: int) -> FieldSpec:
    return FieldSpec(name, FieldKind.FIXED, width)


SPAL_POLICY_COMMITMENT = Structure(
    name="spal_policy_commitment",
    domain_separator="PCI/spal-commit/v1",
    specs=(
        _var("domain_sep"),
        _var("policy_id"),
        _var("owner_did"),
        _fixed("schema_version", 2),
        _fixed("content_hash", 32),
    ),
)

SPAL_ZK_PUBLIC_INPUT = Structure(
    name="spal_zk_public_input",
    domain_separator="PCI/spal-pubin/v2",
    specs=(
        _var("domain_sep"),
        _fixed("script_hash", 28),
        _fixed("spend_ref_hash", 32),
        _fixed("policy_content_hash", 32),
        _var("context_scope"),
        _fixed("required_proof_hash", 32),
        _fixed("subject_hash", 28),
        _fixed("access_time", 8),
        _fixed("payment_commitment", 32),
    ),
)

PAYMENT_COMMITMENT = Structure(
    name="payment_commitment",
    domain_separator="PCI/spal-payment/v2",
    specs=(
        _var("domain_sep"),
        _var("currency"),
        _fixed("amount", 8),
    ),
)

DID_SIGNED_REQUEST_ENVELOPE = Structure(
    name="did_signed_request_envelope",
    domain_separator="PCI/did-envelope/v1",
    specs=(
        _var("domain_sep"),
        _var("sender_did"),
        _var("recipient_did"),
        _var("action"),
        _var("policy_id"),
        _fixed("nonce", 16),
        _fixed("issued_at", 8),
        _fixed("expires_at", 8),
        _fixed("body_hash", 32),
    ),
)

STRUCTURES: dict[str, Structure] = {
    structure.name: structure
    for structure in (
        SPAL_POLICY_COMMITMENT,
        PAYMENT_COMMITMENT,
        SPAL_ZK_PUBLIC_INPUT,
        DID_SIGNED_REQUEST_ENVELOPE,
    )
}


def validate_currency(value: bytes) -> None:
    """Reject a settlement currency field whose layout violates the currency registry.

    Length-prefixing keeps the enclosing preimage injective whatever the field
    contains, so this is not an injectivity check: it stops a malformed
    currency being committed to in the first place.

    Args:
        value: The whole ``currency`` field, tag byte included.

    Raises:
        CurrencyError: The field is empty, carries an unregistered tag, or does
            not match the layout that tag fixes. A rejected field is never
            truncated, padded, or otherwise repaired.
    """
    if not value:
        raise CurrencyError("currency field is empty; its first byte is the currency tag")
    try:
        tag = CurrencyTag(value[0])
    except ValueError as error:
        raise CurrencyError(f"unregistered currency tag 0x{value[0]:02x}") from error

    if tag is not CurrencyTag.CARDANO_NATIVE:
        if len(value) != 1:
            raise CurrencyError(
                f"currency {tag.name.lower()} is the tag byte alone, got {len(value)} bytes"
            )
        return

    after_tag = len(value) - 1
    if after_tag < CARDANO_POLICY_ID_WIDTH:
        raise CurrencyError(
            f"Cardano native currency requires a {CARDANO_POLICY_ID_WIDTH}-byte minting policy "
            f"id, got {after_tag} byte(s) after the tag"
        )
    asset_name_length = after_tag - CARDANO_POLICY_ID_WIDTH
    if asset_name_length > CARDANO_MAX_ASSET_NAME_LENGTH:
        raise CurrencyError(
            f"Cardano native asset name is at most {CARDANO_MAX_ASSET_NAME_LENGTH} bytes, "
            f"got {asset_name_length}"
        )


def validate_fields(structure: Structure, values: Sequence[bytes]) -> None:
    """Apply the field grammars a structure imposes beyond field kind and width.

    Structures whose fields are fully described by their kind and width impose
    no further rules, and validating them succeeds trivially.

    Args:
        structure: The registered structure the values belong to.
        values: The field values in schema order, one per spec.

    Raises:
        ValueError: The number of values does not match the structure's schema.
        CurrencyError: A settlement currency field violates the currency registry.
    """
    if len(values) != len(structure.specs):
        raise ValueError(
            f"structure '{structure.name}' has {len(structure.specs)} fields, got {len(values)}"
        )
    if structure is PAYMENT_COMMITMENT:
        by_name = {spec.name: value for spec, value in zip(structure.specs, values, strict=True)}
        validate_currency(by_name["currency"])
