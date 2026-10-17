import json
from pathlib import Path

import pytest

from pci_preimage import (
    CARDANO_MAX_ASSET_NAME_LENGTH,
    CARDANO_POLICY_ID_WIDTH,
    PAYMENT_COMMITMENT,
    SPAL_POLICY_COMMITMENT,
    CurrencyError,
    validate_currency,
    validate_fields,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[1] / "schemas" / "encoding" / "v1.0" / "test-vectors.json"
)
DOC = json.loads(VECTORS_PATH.read_text())
CURRENCY_RULE = next(v for v in DOC["validation"] if v["name"] == "malformed-currency-rejected")

POLICY_ID = b"\xaa" * CARDANO_POLICY_ID_WIDTH


def cardano_native(asset_name: bytes) -> bytes:
    return b"\x04" + POLICY_ID + asset_name


@pytest.mark.parametrize(
    "value",
    [
        b"\x01",
        b"\x02",
        b"\x03",
        cardano_native(b""),
        cardano_native(b"USDCx"),
        cardano_native(b"n" * CARDANO_MAX_ASSET_NAME_LENGTH),
    ],
    ids=["sats", "lovelace", "usd-cents", "native-no-asset-name", "native", "native-max-asset"],
)
def test_registered_currency_layouts_are_accepted(value: bytes) -> None:
    validate_currency(value)


def test_empty_currency_is_rejected() -> None:
    with pytest.raises(CurrencyError):
        validate_currency(b"")


@pytest.mark.parametrize("tag", [0x00, 0x05, 0xFF], ids=lambda t: f"tag-{t:#04x}")
def test_unregistered_currency_tag_is_rejected(tag: int) -> None:
    with pytest.raises(CurrencyError):
        validate_currency(bytes([tag]))


@pytest.mark.parametrize("tag", [0x01, 0x02, 0x03], ids=["sats", "lovelace", "usd-cents"])
def test_tag_only_currency_with_trailing_bytes_is_rejected(tag: int) -> None:
    with pytest.raises(CurrencyError):
        validate_currency(bytes([tag]) + b"\xff")


@pytest.mark.parametrize("width", [0, 1, CARDANO_POLICY_ID_WIDTH - 1], ids=["none", "one", "short"])
def test_cardano_native_currency_with_undersized_policy_id_is_rejected(width: int) -> None:
    with pytest.raises(CurrencyError):
        validate_currency(b"\x04" + b"\xaa" * width)


def test_cardano_native_currency_with_oversized_asset_name_is_rejected() -> None:
    with pytest.raises(CurrencyError):
        validate_currency(cardano_native(b"n" * (CARDANO_MAX_ASSET_NAME_LENGTH + 1)))


def test_payment_commitment_fields_reject_a_malformed_currency() -> None:
    values = [
        PAYMENT_COMMITMENT.domain_separator.encode("utf-8"),
        b"\x04" + b"\xaa" * (CARDANO_POLICY_ID_WIDTH - 1),
        (100).to_bytes(8, "big"),
    ]
    with pytest.raises(CurrencyError):
        validate_fields(PAYMENT_COMMITMENT, values)


def test_payment_commitment_fields_accept_a_registered_currency() -> None:
    values = [
        PAYMENT_COMMITMENT.domain_separator.encode("utf-8"),
        cardano_native(b"USDCx"),
        (100).to_bytes(8, "big"),
    ]
    validate_fields(PAYMENT_COMMITMENT, values)


def test_structure_without_a_field_grammar_accepts_any_values() -> None:
    values = [
        SPAL_POLICY_COMMITMENT.domain_separator.encode("utf-8"),
        b"spal:did:pci:cardano:addr1abc:health",
        b"did:pci:cardano:addr1abc",
        b"\x01\x00",
        b"\x11" * 32,
    ]
    validate_fields(SPAL_POLICY_COMMITMENT, values)


@pytest.mark.parametrize("case", CURRENCY_RULE["must_reject"], ids=lambda c: c["name"])
def test_committed_currency_rejection_cases_are_rejected(case: dict) -> None:
    assert case["rejected"] is True
    with pytest.raises(CurrencyError):
        validate_currency(bytes.fromhex(case["currency_hex"]))


def test_committed_currency_widths_match_the_reference_implementation() -> None:
    assert CURRENCY_RULE["cardano_policy_id_width"] == CARDANO_POLICY_ID_WIDTH
    assert CURRENCY_RULE["cardano_max_asset_name_length"] == CARDANO_MAX_ASSET_NAME_LENGTH


def test_value_count_must_match_the_structure_schema() -> None:
    with pytest.raises(ValueError, match="fields"):
        validate_fields(PAYMENT_COMMITMENT, [PAYMENT_COMMITMENT.domain_separator.encode("utf-8")])
