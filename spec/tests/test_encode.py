import json
from pathlib import Path

import pytest

from pci_preimage import (
    MAX_VARIABLE_FIELD_LENGTH,
    Field,
    FieldTooLongError,
    FixedField,
    FixedWidthError,
    VariableField,
    encode,
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
        "raw_a": [b"PCI/x", b"Ypayload"],
        "raw_b": [b"PCI/xY", b"payload"],
        "encoded_a": [b"PCI/x", b"Ypayload"],
        "encoded_b": [b"PCI/xY", b"payload"],
    },
    "spal-identifier-repartition": {
        "raw_a": [b"spal:did:pci:cardano:addr1abc", b"123:health"],
        "raw_b": [b"spal:did:pci:cardano:addr1abc123", b":health"],
        "encoded_a": [
            b"PCI/spal-commit/v1",
            b"spal:did:pci:cardano:addr1abc",
            b"123:health",
        ],
        "encoded_b": [
            b"PCI/spal-commit/v1",
            b"spal:did:pci:cardano:addr1abc123",
            b":health",
        ],
    },
}


def fields_from_json(entries: list[dict]) -> list[Field]:
    fields: list[Field] = []
    for entry in entries:
        if entry["kind"] == "var" and "value_utf8" in entry:
            fields.append(VariableField(entry["value_utf8"].encode("utf-8")))
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


def test_over_length_rule_is_declared_in_vector_file() -> None:
    (rule,) = [v for v in DOC["validation"] if v["name"] == "over-length-field-rejected"]
    assert rule["max_field_length"] == MAX_VARIABLE_FIELD_LENGTH
    assert rule["must_reject"] is True
