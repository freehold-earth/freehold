import json
from pathlib import Path

import pytest

from pci_preimage import (
    STRUCTURES,
    DecodeError,
    FieldKind,
    FieldSpec,
    FixedField,
    VariableField,
    decode,
    encode,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[1] / "schemas" / "encoding" / "v1.0" / "test-vectors.json"
)
DOC = json.loads(VECTORS_PATH.read_text())

TWO_VARIABLE_FIELDS = (
    FieldSpec("first", FieldKind.VARIABLE),
    FieldSpec("second", FieldKind.VARIABLE),
)


def value_bytes(entry: dict) -> bytes:
    if entry["kind"] == "var" and "value_utf8" in entry:
        return entry["value_utf8"].encode("utf-8")
    return bytes.fromhex(entry["value_hex"])


@pytest.mark.parametrize("vector", DOC["vectors"], ids=lambda v: v["name"])
def test_round_trip_re_derives_field_tuple(vector: dict) -> None:
    structure = STRUCTURES[vector["structure"]]
    expected = tuple(value_bytes(entry) for entry in vector["fields"])
    assert decode(bytes.fromhex(vector["encoding_hex"]), structure.specs) == expected


def test_round_trip_over_encode_output() -> None:
    fields = (
        VariableField(b"PCI/spal-payment/v2"),
        VariableField(b"\x01"),
        FixedField(b"\x00" * 7 + b"\x64", 8),
    )
    structure = STRUCTURES["payment_commitment"]
    assert decode(encode(fields), structure.specs) == tuple(f.value for f in fields)


def test_adversarial_encodings_decode_to_their_own_tuples() -> None:
    encoded_a = encode([VariableField(b"alice"), VariableField(b"bob123")])
    encoded_b = encode([VariableField(b"aliceb"), VariableField(b"ob123")])
    assert decode(encoded_a, TWO_VARIABLE_FIELDS) == (b"alice", b"bob123")
    assert decode(encoded_b, TWO_VARIABLE_FIELDS) == (b"aliceb", b"ob123")


def test_decode_rejects_truncated_length_prefix() -> None:
    with pytest.raises(DecodeError):
        decode(b"\x00\x00\x01", (FieldSpec("first", FieldKind.VARIABLE),))


def test_decode_rejects_length_prefix_running_past_end() -> None:
    with pytest.raises(DecodeError):
        decode(b"\x00\x00\x00\x05abc", (FieldSpec("first", FieldKind.VARIABLE),))


def test_decode_rejects_truncated_fixed_field() -> None:
    with pytest.raises(DecodeError):
        decode(b"\x01\x02", (FieldSpec("digest", FieldKind.FIXED, 4),))


def test_decode_rejects_trailing_bytes() -> None:
    data = encode([VariableField(b"alice")]) + b"\x00"
    with pytest.raises(DecodeError):
        decode(data, (FieldSpec("first", FieldKind.VARIABLE),))


def test_fixed_field_spec_requires_positive_width() -> None:
    with pytest.raises(ValueError):
        FieldSpec("digest", FieldKind.FIXED)
    with pytest.raises(ValueError):
        FieldSpec("digest", FieldKind.FIXED, 0)


def test_variable_field_spec_must_not_pin_width() -> None:
    with pytest.raises(ValueError):
        FieldSpec("scope", FieldKind.VARIABLE, 32)


def test_registry_covers_all_vector_structures() -> None:
    assert {vector["structure"] for vector in DOC["vectors"]} <= set(STRUCTURES)
    domain_separators = {s.domain_separator for s in STRUCTURES.values()}
    assert domain_separators == set(DOC["domain_separator_registry"])
