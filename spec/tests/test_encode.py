import json
import unicodedata
from pathlib import Path

import pytest

from freehold_preimage import (
    MAX_VARIABLE_FIELD_LENGTH,
    TERMS_RECEIPT,
    Field,
    FieldKind,
    FieldTooLongError,
    FixedField,
    FixedWidthError,
    TextEncodingError,
    VariableField,
    decode_text,
    encode,
    encode_text,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[1] / "schemas" / "encoding" / "v1.0" / "test-vectors.json"
)
DOC = json.loads(VECTORS_PATH.read_text())

# The byte tuples behind each adversarial case, re-stated independently of the
# generator so the committed hex is verified against a second derivation.
ADVERSARIAL_PARTS = {
    "boundary-move-two-fields": {
        "raw_a": [b"alice", b"bob123"],
        "raw_b": [b"aliceb", b"ob123"],
        "encoded_a": [b"alice", b"bob123"],
        "encoded_b": [b"aliceb", b"ob123"],
    },
    "domain-separator-boundary-move": {
        "raw_a": [b"spal/x", b"Ypayload"],
        "raw_b": [b"spal/xY", b"payload"],
        "encoded_a": [b"spal/x", b"Ypayload"],
        "encoded_b": [b"spal/xY", b"payload"],
    },
    "spal-identifier-repartition": {
        "raw_a": [b"spal:did:key:z6Mkowner", b"123:health"],
        "raw_b": [b"spal:did:key:z6Mkowner123", b":health"],
        "encoded_a": [
            b"spal/commit/v1",
            b"spal:did:key:z6Mkowner",
            b"123:health",
        ],
        "encoded_b": [
            b"spal/commit/v1",
            b"spal:did:key:z6Mkowner123",
            b":health",
        ],
    },
    "did-authorization-did-boundary-move": {
        "raw_a": [b"did:key:z6MkA", b"BCDdid:key:z6MkRoot"],
        "raw_b": [b"did:key:z6MkABCD", b"did:key:z6MkRoot"],
        "encoded_a": [
            b"spal/did-authorization/v2",
            b"did:key:z6MkA",
            b"BCDdid:key:z6MkRoot",
        ],
        "encoded_b": [
            b"spal/did-authorization/v2",
            b"did:key:z6MkABCD",
            b"did:key:z6MkRoot",
        ],
    },
}


def fields_from_json(entries: list[dict]) -> list[Field]:
    fields: list[Field] = []
    for entry in entries:
        if entry["kind"] == "var" and "value_utf8" in entry:
            fields.append(VariableField(encode_text(entry["value_utf8"])))
        elif entry["kind"] == "var":
            fields.append(VariableField(bytes.fromhex(entry["value_hex"])))
        else:
            fields.append(FixedField(bytes.fromhex(entry["value_hex"]), entry["width"]))
    return fields


@pytest.mark.parametrize("vector", DOC["vectors"], ids=lambda v: v["name"])
def test_encoding_matches_committed_vector(vector: dict) -> None:
    assert encode(fields_from_json(vector["fields"])).hex() == vector["encoding_hex"]


def test_empty_variable_field_still_emits_length_prefix() -> None:
    assert encode([VariableField(b"")]) == b"\x00\x00\x00\x00"


class _OverLengthBytes(bytes):
    """Bytes stand-in reporting a length past the uint32 maximum without allocating it."""

    def __len__(self) -> int:
        return MAX_VARIABLE_FIELD_LENGTH + 1


def test_variable_field_longer_than_maximum_is_rejected() -> None:
    with pytest.raises(FieldTooLongError):
        encode([VariableField(_OverLengthBytes())])


@pytest.mark.parametrize("value", [b"\x11" * 31, b"\x11" * 33], ids=["too-short", "too-long"])
def test_fixed_field_width_mismatch_is_rejected(value: bytes) -> None:
    with pytest.raises(FixedWidthError):
        encode([FixedField(value, 32)])


def test_fixed_width_is_schema_driven_not_value_driven() -> None:
    with pytest.raises(FixedWidthError):
        encode([FixedField(b"\x11" * 32, 28)])


@pytest.mark.parametrize("case", DOC["adversarial"], ids=lambda c: c["name"])
def test_raw_concat_collides_but_canonical_encoding_is_distinct(case: dict) -> None:
    parts = ADVERSARIAL_PARTS[case["name"]]

    raw_a = b"".join(parts["raw_a"])
    raw_b = b"".join(parts["raw_b"])
    assert raw_a == raw_b
    assert raw_a.hex() == case["raw_concat_a_hex"]
    assert raw_b.hex() == case["raw_concat_b_hex"]
    assert case["raw_concat_collides"] is True

    encoded_a = encode([VariableField(part) for part in parts["encoded_a"]])
    encoded_b = encode([VariableField(part) for part in parts["encoded_b"]])
    assert encoded_a.hex() == case["encoding_a_hex"]
    assert encoded_b.hex() == case["encoding_b_hex"]
    assert encoded_a != encoded_b
    assert case["encoding_distinct"] is True


TEXT_RULE = next(rule for rule in DOC["validation"] if rule["name"] == "text-field-encoding")


def test_text_field_rule_is_declared_in_vector_file() -> None:
    assert TEXT_RULE["encoding"] == "utf-8"
    assert TEXT_RULE["normalisation"].startswith("none")


def _text_from_code_points(code_points: list[str]) -> str:
    return "".join(chr(int(point.removeprefix("U+"), 16)) for point in code_points)


@pytest.mark.parametrize("case", TEXT_RULE["must_reject"], ids=lambda c: c["name"])
def test_text_field_rejection_cases_are_rejected(case: dict) -> None:
    with pytest.raises(TextEncodingError):
        if "code_points" in case:
            encode_text(_text_from_code_points(case["code_points"]))
        else:
            decode_text(bytes.fromhex(case["bytes_hex"]))


def test_text_fields_round_trip_through_decode_text() -> None:
    for text in ("caf\u00e9", "cafe\u0301", "", "did:key:z6Mkabc", "Age\ufeffverification"):
        assert decode_text(encode_text(text)) == text


def test_text_fields_are_utf8_as_given_without_normalisation() -> None:
    nfc = "caf\u00e9"
    nfd = "cafe\u0301"
    assert unicodedata.normalize("NFC", nfd) == nfc
    assert encode_text(nfc) == nfc.encode("utf-8")
    assert encode_text(nfd) == nfd.encode("utf-8")
    assert encode_text(nfc) != encode_text(nfd)
    by_name = {vector["name"]: vector for vector in DOC["vectors"]}
    assert (
        by_name["did-authorization-purpose-nfc"]["encoding_hex"]
        != by_name["did-authorization-purpose-nfd"]["encoding_hex"]
    )


def test_over_length_rule_is_declared_in_vector_file() -> None:
    (rule,) = [v for v in DOC["validation"] if v["name"] == "over-length-field-rejected"]
    assert rule["max_field_length"] == MAX_VARIABLE_FIELD_LENGTH
    assert rule["must_reject"] is True


def test_terms_receipt_encodes_to_its_vector() -> None:
    """The receipt's field order, built by hand, reproduces the committed vector."""
    vector = next(v for v in DOC["vectors"] if v["name"] == "receipt-served")
    values: dict[str, bytes] = {
        "domain_sep": TERMS_RECEIPT.domain_separator.encode(),
        "operator_did": b"did:key:z6Mkoperator789",
        "terms_hash": bytes.fromhex("aa" * 32),
        "request_hash": bytes.fromhex("bb" * 32),
        "nonce": bytes.fromhex("cc" * 16),
        "request_id": b"req-7f3e2a1c",
        "served_at": (0x687CA840).to_bytes(8, "big"),
        "custody": b"federated_operator",
        "retention_seconds": (0).to_bytes(8, "big"),
        "training": b"forbidden",
        "aggregation": b"forbidden",
        "resale": b"forbidden",
    }
    fields: list[Field] = []
    for spec in TERMS_RECEIPT.specs:
        if spec.kind is FieldKind.VARIABLE:
            fields.append(VariableField(values[spec.name]))
        else:
            assert spec.width is not None
            fields.append(FixedField(values[spec.name], spec.width))
    assert encode(fields).hex() == vector["encoding_hex"]
