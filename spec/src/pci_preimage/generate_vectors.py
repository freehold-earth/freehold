"""Generator for the committed canonical-encoding test vectors.

Rebuilds ``schemas/encoding/v1.0/test-vectors.json`` from the reference
encoder, so the vectors are reproducible rather than trusted. Run as
``python -m pci_preimage.generate_vectors [output-path]``.
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

from pci_preimage.encoding import (
    MAX_VARIABLE_FIELD_LENGTH,
    Field,
    FieldKind,
    FixedField,
    VariableField,
    encode,
)
from pci_preimage.structures import (
    CARDANO_MAX_ASSET_NAME_LENGTH,
    CARDANO_POLICY_ID_WIDTH,
    STRUCTURES,
    CurrencyError,
    Structure,
    validate_currency,
    validate_fields,
)

DEFAULT_OUTPUT = Path("schemas/encoding/v1.0/test-vectors.json")


@dataclass(frozen=True)
class _VectorField:
    name: str
    field: Field
    note: str | None = None


def _var(name: str, text: str, note: str | None = None) -> _VectorField:
    return _VectorField(name, VariableField(text.encode("utf-8")), note)


def _var_hex(name: str, value_hex: str, note: str | None = None) -> _VectorField:
    return _VectorField(name, VariableField(bytes.fromhex(value_hex)), note)


def _fixed(name: str, value_hex: str, width: int, note: str | None = None) -> _VectorField:
    return _VectorField(name, FixedField(bytes.fromhex(value_hex), width), note)


def _check_against_structure(structure: Structure, fields: list[_VectorField]) -> None:
    """Reject fields whose names, kinds, widths, or domain separator diverge from the schema."""
    names = [field.name for field in fields]
    expected = [spec.name for spec in structure.specs]
    if names != expected:
        raise ValueError(f"structure '{structure.name}' expects fields {expected}, got {names}")
    for spec, vector_field in zip(structure.specs, fields, strict=True):
        if spec.kind is FieldKind.VARIABLE and not isinstance(vector_field.field, VariableField):
            raise ValueError(f"field '{spec.name}' must be variable-length")
        if spec.kind is FieldKind.FIXED and (
            not isinstance(vector_field.field, FixedField) or vector_field.field.width != spec.width
        ):
            raise ValueError(f"field '{spec.name}' must be fixed-width of {spec.width} bytes")
    validate_fields(structure, [vector_field.field.value for vector_field in fields])
    domain_sep = fields[0].field.value
    if domain_sep != structure.domain_separator.encode("utf-8"):
        raise ValueError(
            f"structure '{structure.name}' requires domain separator '{structure.domain_separator}'"
        )


def _field_json(vector_field: _VectorField) -> dict:
    entry: dict = {"name": vector_field.name}
    if isinstance(vector_field.field, VariableField):
        entry["kind"] = "var"
        value = vector_field.field.value
        if value.isascii() and value.decode("ascii").isprintable():
            entry["value_utf8"] = value.decode("ascii")
        else:
            entry["value_hex"] = value.hex()
    else:
        entry["kind"] = "fixed"
        entry["width"] = vector_field.field.width
        entry["value_hex"] = vector_field.field.value.hex()
    if vector_field.note is not None:
        entry["note"] = vector_field.note
    return entry


def _vector(
    name: str,
    structure: Structure,
    fields: list[_VectorField],
    note: str | None = None,
) -> dict:
    _check_against_structure(structure, fields)
    entry: dict = {
        "name": name,
        "structure": structure.name,
        "domain_sep": structure.domain_separator,
    }
    if note is not None:
        entry["note"] = note
    entry["fields"] = [_field_json(field) for field in fields]
    entry["encoding_hex"] = encode([field.field for field in fields]).hex()
    return entry


def _adversarial(
    name: str,
    description: str,
    raw_a: list[bytes],
    raw_b: list[bytes],
    encoded_a: list[bytes],
    encoded_b: list[bytes],
) -> dict:
    """Build one case where raw concatenations collide but canonical encodings stay distinct."""
    raw_concat_a = b"".join(raw_a)
    raw_concat_b = b"".join(raw_b)
    encoding_a = encode([VariableField(part) for part in encoded_a])
    encoding_b = encode([VariableField(part) for part in encoded_b])
    return {
        "name": name,
        "description": description,
        "raw_concat_a_hex": raw_concat_a.hex(),
        "raw_concat_b_hex": raw_concat_b.hex(),
        "raw_concat_collides": raw_concat_a == raw_concat_b,
        "encoding_a_hex": encoding_a.hex(),
        "encoding_b_hex": encoding_b.hex(),
        "encoding_distinct": encoding_a != encoding_b,
    }


def _rejected_currency(name: str, currency: bytes, reason: str) -> dict:
    """Build one currency the reference validator must reject, recording that it did.

    Raises:
        ValueError: The reference validator accepted the currency, so the case
            would be committed as a rejection that does not happen.
    """
    try:
        validate_currency(currency)
    except CurrencyError:
        rejected = True
    else:
        rejected = False
    if not rejected:
        raise ValueError(f"currency case '{name}' was accepted but is committed as rejected")
    return {
        "name": name,
        "reason": reason,
        "currency_hex": currency.hex(),
        "rejected": rejected,
    }


def _currency_grammar_rule() -> dict:
    policy_id = b"\xaa" * CARDANO_POLICY_ID_WIDTH
    return {
        "name": "malformed-currency-rejected",
        "description": (
            "The currency field's internal layout is fixed by its tag byte. An encoder "
            "MUST reject a field that does not match the layout its tag fixes, never "
            "truncating, padding, or otherwise repairing it."
        ),
        "structure": "payment_commitment",
        "field": "currency",
        "cardano_policy_id_width": CARDANO_POLICY_ID_WIDTH,
        "cardano_max_asset_name_length": CARDANO_MAX_ASSET_NAME_LENGTH,
        "must_reject": [
            _rejected_currency(
                "empty-currency",
                b"",
                "no tag byte, so no layout is determined",
            ),
            _rejected_currency(
                "unregistered-tag",
                b"\x05",
                "tag 0x05 is not in the currency registry",
            ),
            _rejected_currency(
                "tag-only-currency-with-trailing-bytes",
                b"\x01\xff",
                "sats is the tag byte alone; trailing bytes are not part of its layout",
            ),
            _rejected_currency(
                "cardano-native-policy-id-too-short",
                b"\x04" + policy_id[:-1],
                (
                    f"minting policy id must be exactly {CARDANO_POLICY_ID_WIDTH} bytes, "
                    f"here {CARDANO_POLICY_ID_WIDTH - 1}"
                ),
            ),
            _rejected_currency(
                "cardano-native-asset-name-too-long",
                b"\x04" + policy_id + b"n" * (CARDANO_MAX_ASSET_NAME_LENGTH + 1),
                (
                    f"asset name must be at most {CARDANO_MAX_ASSET_NAME_LENGTH} bytes, "
                    f"here {CARDANO_MAX_ASSET_NAME_LENGTH + 1}"
                ),
            ),
        ],
    }


def build_vectors() -> dict:
    """Build the complete test-vector document as a JSON-shaped dictionary.

    Returns:
        The document with every ``encoding_hex``, collision flag, and
        distinctness flag computed by the reference encoder rather than
        transcribed by hand.
    """
    commitment = STRUCTURES["spal_policy_commitment"]
    payment = STRUCTURES["payment_commitment"]
    public_input = STRUCTURES["spal_zk_public_input"]
    envelope = STRUCTURES["did_signed_request_envelope"]

    vectors = [
        _vector(
            "spal-commitment-health-records",
            commitment,
            [
                _var("domain_sep", commitment.domain_separator),
                _var("policy_id", "spal:did:pci:cardano:addr1abc123:health-records"),
                _var("owner_did", "did:pci:cardano:addr1abc123"),
                _fixed("schema_version", "0100", 2),
                _fixed("content_hash", "11" * 32, 32),
            ],
        ),
        _vector(
            "payment-commitment-100-sats",
            payment,
            [
                _var("domain_sep", payment.domain_separator),
                _var_hex("currency", "01", note="currency tag: sats=0x01"),
                _fixed("amount", "0000000000000064", 8),
            ],
        ),
        _vector(
            "payment-commitment-2-ada",
            payment,
            [
                _var("domain_sep", payment.domain_separator),
                _var_hex("currency", "02", note="currency tag: lovelace=0x02"),
                _fixed("amount", "00000000001e8480", 8),
            ],
        ),
        _vector(
            "payment-commitment-cardano-native-usdcx",
            payment,
            [
                _var("domain_sep", payment.domain_separator),
                _var_hex(
                    "currency",
                    "04" + "aa" * 28 + "5553444378",
                    note=(
                        "currency tag cardano_native=0x04, followed by the 28-byte "
                        "minting policy id and the asset name (here 'USDCx'); the "
                        "internal layout is injective because the tag and policy id "
                        "are fixed-width and the asset name is terminal"
                    ),
                ),
                _fixed("amount", "00000000004c4b40", 8),
            ],
        ),
        _vector(
            "spal-pubin-diagnosis-codes",
            public_input,
            [
                _var("domain_sep", public_input.domain_separator),
                _fixed("script_hash", "66" * 28, 28),
                _fixed("spend_ref_hash", "99" * 32, 32),
                _fixed("policy_content_hash", "22" * 32, 32),
                _var("context_scope", "medical/diagnosis_codes"),
                _fixed("required_proof_hash", "33" * 32, 32),
                _fixed("subject_hash", "44" * 28, 28),
                _fixed("access_time", "00000000687ca840", 8),
                _fixed("payment_commitment", "55" * 32, 32),
            ],
        ),
        _vector(
            "did-envelope-negotiate",
            envelope,
            [
                _var("domain_sep", envelope.domain_separator),
                _var("sender_did", "did:pci:ephemeral:z6Mkabc"),
                _var("recipient_did", "did:web:example.com"),
                _var("action", "negotiate"),
                _var("policy_id", "spal:did:pci:cardano:addr1abc123:health-records"),
                _fixed("nonce", "77" * 16, 16),
                _fixed("issued_at", "00000000687ca840", 8),
                _fixed("expires_at", "00000000687cb650", 8),
                _fixed("body_hash", "88" * 32, 32),
            ],
        ),
        _vector(
            "did-envelope-empty-policy-id",
            envelope,
            [
                _var("domain_sep", envelope.domain_separator),
                _var("sender_did", "did:pci:ephemeral:z6Mkabc"),
                _var("recipient_did", "did:web:example.com"),
                _var("action", "proof.submit"),
                _var("policy_id", ""),
                _fixed("nonce", "77" * 16, 16),
                _fixed("issued_at", "00000000687ca840", 8),
                _fixed("expires_at", "00000000687cb650", 8),
                _fixed("body_hash", "88" * 32, 32),
            ],
            note=(
                "An empty variable-length field is still emitted with its 4-byte length "
                "prefix (00000000). Empty is distinct from a different value; all fields "
                "are mandatory in a given structure version."
            ),
        ),
    ]

    adversarial = [
        _adversarial(
            "boundary-move-two-fields",
            (
                "Raw concatenation makes ('alice','bob123') and ('aliceb','ob123') "
                "collide to 'alicebob123'. Length prefixing makes them distinct."
            ),
            raw_a=[b"alice", b"bob123"],
            raw_b=[b"aliceb", b"ob123"],
            encoded_a=[b"alice", b"bob123"],
            encoded_b=[b"aliceb", b"ob123"],
        ),
        _adversarial(
            "domain-separator-boundary-move",
            (
                "If the domain separator were prepended raw, dom='PCI/x' + 'Ypayload' "
                "and dom='PCI/xY' + 'payload' would collide. As the first "
                "length-prefixed field, they are distinct."
            ),
            raw_a=[b"PCI/x", b"Ypayload"],
            raw_b=[b"PCI/xY", b"payload"],
            encoded_a=[b"PCI/x", b"Ypayload"],
            encoded_b=[b"PCI/xY", b"payload"],
        ),
        _adversarial(
            "spal-identifier-repartition",
            (
                "Moving the boundary between policy_id and owner_did (the PCI-specific "
                "version of the Wanchain TreasuryCheck attack) yields distinct "
                "encodings under the canonical rule."
            ),
            raw_a=[b"spal:did:pci:cardano:addr1abc", b"123:health"],
            raw_b=[b"spal:did:pci:cardano:addr1abc123", b":health"],
            encoded_a=[
                commitment.domain_separator.encode("utf-8"),
                b"spal:did:pci:cardano:addr1abc",
                b"123:health",
            ],
            encoded_b=[
                commitment.domain_separator.encode("utf-8"),
                b"spal:did:pci:cardano:addr1abc123",
                b":health",
            ],
        ),
    ]

    return {
        "version": "1.1",
        "spec": "protocols/preimage-encoding.md",
        "description": (
            "Canonical preimage encoding test vectors. Values are ENCODINGS "
            "(hash-agnostic); no hash function is applied. Fixed digest inputs use "
            "recognisable placeholder byte patterns."
        ),
        "encoding_rule": {
            "length_prefix": "uint32 big-endian",
            "max_field_length": MAX_VARIABLE_FIELD_LENGTH,
            "fixed_width_fields": "emitted raw at schema-pinned width, no prefix",
            "domain_separator": "first field, variable-length, length-prefixed",
            "hash": "NOT specified here; chosen downstream (ADR-005/ADR-007)",
        },
        "domain_separator_registry": {
            "PCI/spal-commit/v1": "S-PAL policy commitment (yields policy_content_hash)",
            "PCI/spal-pubin/v2": "S-PAL zero-knowledge public input",
            "PCI/did-envelope/v1": "DID-signed request envelope",
            "PCI/spal-payment/v2": "payment commitment (nested in spal-pubin)",
        },
        "retired_domain_separators": {
            "PCI/spal-pubin/v1": (
                "superseded by v2 (added spend_ref_hash, renamed policy_hash to "
                "policy_content_hash) before any implementation existed"
            ),
            "PCI/spal-payment/v1": (
                "superseded by v2 (currency became a variable-length "
                "chain-settlement field) before any implementation existed"
            ),
        },
        "vectors": vectors,
        "adversarial": adversarial,
        "validation": [
            {
                "name": "over-length-field-rejected",
                "description": (
                    "A variable-length field longer than max_field_length MUST be "
                    "rejected by encoders, never wrapped or truncated."
                ),
                "max_field_length": MAX_VARIABLE_FIELD_LENGTH,
                "must_reject": True,
            },
            _currency_grammar_rule(),
        ],
    }


def render(document: dict) -> str:
    """Render the vector document as committed JSON text (2-space indent, final newline)."""
    return json.dumps(document, indent=2) + "\n"


def main(argv: list[str] | None = None) -> None:
    """Write the generated test vectors to the output path.

    Args:
        argv: Command-line arguments; defaults to ``sys.argv[1:]``.
    """
    parser = argparse.ArgumentParser(
        description="Regenerate the canonical preimage encoding test vectors."
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=DEFAULT_OUTPUT,
        type=Path,
        help=f"output path (default: {DEFAULT_OUTPUT})",
    )
    args = parser.parse_args(argv)
    args.output.write_text(render(build_vectors()), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
