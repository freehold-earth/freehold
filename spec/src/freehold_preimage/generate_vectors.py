"""Generator for the committed canonical-encoding test vectors.

Rebuilds ``schemas/encoding/v1.0/test-vectors.json`` from the reference
encoder, so the vectors are reproducible rather than trusted. Run as
``python -m freehold_preimage.generate_vectors [output-path]``.
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

from freehold_preimage.encoding import (
    MAX_VARIABLE_FIELD_LENGTH,
    Field,
    FieldKind,
    FixedField,
    VariableField,
    encode,
    encode_text,
)
from freehold_preimage.structures import (
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
    return _VectorField(name, VariableField(encode_text(text)), note)


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
    if domain_sep != encode_text(structure.domain_separator):
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


def _text_field_rule() -> dict:
    """Declare the text-field rule with the values an encoder must reject."""
    return {
        "name": "text-field-encoding",
        "description": (
            "A text field is the UTF-8 bytes of the value as given: no byte-order mark "
            "and no Unicode normalisation. An encoder MUST reject a value that is not "
            "well-formed Unicode or that begins with U+FEFF, never replacing or "
            "stripping anything; a decoder MUST reject field bytes that are not "
            "well-formed UTF-8 or that begin with the byte-order mark. Equivalent-looking "
            "values that differ in code points are different values; see the "
            "did-authorization-purpose-nfc and -nfd vectors. Rejected text values are "
            "given as code points (U+XXXX) and rejected bytes as hex."
        ),
        "encoding": "utf-8",
        "byte_order_mark": "never emitted; a value beginning with U+FEFF is rejected",
        "normalisation": "none; bytes are compared as given",
        "must_reject": [
            _rejected_text(
                "leading-bom",
                "\ufeffcaf\u00e9",
                "a leading U+FEFF cannot be told apart from a byte-order mark",
            ),
            _rejected_text(
                "lone-surrogate",
                "caf\ud800",
                "a lone surrogate is not a Unicode scalar value and has no UTF-8 form",
            ),
            _rejected_text_bytes(
                "invalid-utf8-sequence",
                b"caf\xff",
                "0xFF never occurs in well-formed UTF-8",
            ),
            _rejected_text_bytes(
                "encoded-surrogate",
                b"caf\xed\xa0\x80",
                "U+D800 encoded as three bytes is not well-formed UTF-8",
            ),
            _rejected_text_bytes(
                "leading-bom-bytes",
                b"\xef\xbb\xbfcaf\xc3\xa9",
                "the bytes of U+FEFF at the start are a byte-order mark",
            ),
        ],
    }


def _rejected_text(name: str, text: str, reason: str) -> dict:
    """A text value an encoder must reject, given as code points so every parser can carry it."""
    return {
        "name": name,
        "code_points": [f"U+{ord(character):04X}" for character in text],
        "reason": reason,
    }


def _rejected_text_bytes(name: str, value: bytes, reason: str) -> dict:
    """Field bytes a decoder must reject as text."""
    return {"name": name, "bytes_hex": value.hex(), "reason": reason}


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
    authorization = STRUCTURES["did_authorization_record"]
    approval = STRUCTURES["did_approval_attestation"]

    vectors = [
        _vector(
            "spal-commitment-health-records",
            commitment,
            [
                _var("domain_sep", commitment.domain_separator),
                _var("policy_id", "spal:did:key:z6Mkowner123:health-records"),
                _var("owner_did", "did:key:z6Mkowner123"),
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
                _var("sender_did", "did:key:z6Mkabc"),
                _var("recipient_did", "did:web:example.com"),
                _var("action", "negotiate"),
                _var("policy_id", "spal:did:key:z6Mkowner123:health-records"),
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
                _var("sender_did", "did:key:z6Mkabc"),
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
        _vector(
            "did-authorization-age-check",
            authorization,
            [
                _var("domain_sep", authorization.domain_separator),
                _var("ephemeral_did", "did:key:z6Mkephemeral456"),
                _var("root_did", "did:key:z6Mkroot123"),
                _var("purpose", "Age verification at a shop"),
                _var("verification_type", "age_over_18"),
                _var("verifier_did", "did:web:shop.example"),
                _var(
                    "policy_hash",
                    "",
                    note="absent optional context field: empty, still prefixed",
                ),
                _var(
                    "metadata",
                    '{"channel":"in-store"}',
                    note="RFC 8785 canonical JSON of the context metadata object",
                ),
                _var("issued_at", "2026-11-03T10:30:00.000Z"),
                _var("expires_at", "2026-11-03T11:30:00.000Z"),
                _var(
                    "root_key_id",
                    "",
                    note="empty for a did:key root, whose key is the identifier itself",
                ),
            ],
            note=(
                "The record an identity layer signs to link an ephemeral DID to its root. "
                "Timestamps are the ISO 8601 text as recorded; absent optional fields are "
                "empty variable-length fields."
            ),
        ),
        _vector(
            "did-authorization-atproto-root",
            authorization,
            [
                _var("domain_sep", authorization.domain_separator),
                _var("ephemeral_did", "did:key:z6Mkephemeral456"),
                _var("root_did", "did:plc:exampleroot2345abcdefghi"),
                _var("purpose", "Age verification at a shop"),
                _var("verification_type", "age_over_18"),
                _var("verifier_did", ""),
                _var("policy_hash", ""),
                _var("metadata", ""),
                _var("issued_at", "2026-11-03T10:30:00.000Z"),
                _var("expires_at", ""),
                _var(
                    "root_key_id",
                    "bafyreiexamplerootkeybindingrecordcid2345abcdefghijklmnopq",
                    note=(
                        "CID of the earth.freehold.rootKey record the signing key was "
                        "published under, as text"
                    ),
                ),
            ],
            note=(
                "A root that is not a did:key names the binding record its signing key "
                "was published under, so a verifier can check the record against the "
                "key that was current when it was issued."
            ),
        ),
        _vector(
            "did-authorization-purpose-nfc",
            authorization,
            [
                _var("domain_sep", authorization.domain_separator),
                _var("ephemeral_did", "did:key:z6Mkephemeral456"),
                _var("root_did", "did:key:z6Mkroot123"),
                _var("purpose", "caf\u00e9", note="U+00E9, the precomposed form (NFC)"),
                _var("verification_type", "age_over_18"),
                _var("verifier_did", ""),
                _var("policy_hash", ""),
                _var("metadata", ""),
                _var("issued_at", "2026-11-03T10:30:00.000Z"),
                _var("expires_at", ""),
                _var("root_key_id", ""),
            ],
            note=(
                "Text is signed as given, without normalisation: this vector and "
                "did-authorization-purpose-nfd differ only in the code points of the "
                "purpose and encode differently."
            ),
        ),
        _vector(
            "did-authorization-purpose-nfd",
            authorization,
            [
                _var("domain_sep", authorization.domain_separator),
                _var("ephemeral_did", "did:key:z6Mkephemeral456"),
                _var("root_did", "did:key:z6Mkroot123"),
                _var(
                    "purpose",
                    "cafe\u0301",
                    note="U+0065 U+0301, the decomposed form (NFD) of the same word",
                ),
                _var("verification_type", "age_over_18"),
                _var("verifier_did", ""),
                _var("policy_hash", ""),
                _var("metadata", ""),
                _var("issued_at", "2026-11-03T10:30:00.000Z"),
                _var("expires_at", ""),
                _var("root_key_id", ""),
            ],
        ),
        _vector(
            "did-approval-age-check",
            approval,
            [
                _var("domain_sep", approval.domain_separator),
                _var("request_id", "6f1d2c3b-4a5e-4f60-8a71-9b82c3d4e5f6"),
                _var("requester_did", "did:key:z6Mkephemeral456"),
            ],
            note=(
                "The attestation an ephemeral DID's holder signs to approve one "
                "verification request: possession of the DID's key, bound to that "
                "request and nothing else."
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
                "If the domain separator were prepended raw, dom='spal/x' + 'Ypayload' "
                "and dom='spal/xY' + 'payload' would collide. As the first "
                "length-prefixed field, they are distinct."
            ),
            raw_a=[b"spal/x", b"Ypayload"],
            raw_b=[b"spal/xY", b"payload"],
            encoded_a=[b"spal/x", b"Ypayload"],
            encoded_b=[b"spal/xY", b"payload"],
        ),
        _adversarial(
            "spal-identifier-repartition",
            (
                "Moving the boundary between policy_id and owner_did (the S-PAL "
                "version of the Wanchain TreasuryCheck attack) yields distinct "
                "encodings under the canonical rule."
            ),
            raw_a=[b"spal:did:key:z6Mkowner", b"123:health"],
            raw_b=[b"spal:did:key:z6Mkowner123", b":health"],
            encoded_a=[
                commitment.domain_separator.encode("utf-8"),
                b"spal:did:key:z6Mkowner",
                b"123:health",
            ],
            encoded_b=[
                commitment.domain_separator.encode("utf-8"),
                b"spal:did:key:z6Mkowner123",
                b":health",
            ],
        ),
        _adversarial(
            "did-authorization-did-boundary-move",
            (
                "Moving the boundary between ephemeral_did and root_did in an "
                "authorization record: raw concatenation lets a root DID be re-partitioned "
                "into an ephemeral DID it never authorized. Length prefixing keeps the two "
                "records distinct."
            ),
            raw_a=[b"did:key:z6MkA", b"BCDdid:key:z6MkRoot"],
            raw_b=[b"did:key:z6MkABCD", b"did:key:z6MkRoot"],
            encoded_a=[
                authorization.domain_separator.encode("utf-8"),
                b"did:key:z6MkA",
                b"BCDdid:key:z6MkRoot",
            ],
            encoded_b=[
                authorization.domain_separator.encode("utf-8"),
                b"did:key:z6MkABCD",
                b"did:key:z6MkRoot",
            ],
        ),
    ]

    return {
        "version": "1.6",
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
            "spal/commit/v1": "S-PAL policy commitment (yields policy_content_hash)",
            "spal/pubin/v2": "S-PAL zero-knowledge public input",
            "spal/did-envelope/v1": "DID-signed request envelope",
            "spal/did-authorization/v2": "DID authorization record (ephemeral DID to root DID)",
            "spal/did-approval/v1": "DID approval attestation (ephemeral DID holder to a request)",
            "spal/payment/v2": "payment commitment (nested in spal-pubin)",
        },
        "retired_domain_separators": {
            "spal/did-authorization/v1": (
                "superseded by v2 (#92), which appends root_key_id so a root that is not "
                "a did:key can name the binding its signing key was published under; "
                "shipped in freehold-preimage 0.3.0 and identity 0.3.0"
            ),
            "spal/pubin/v1": (
                "reserved; superseded by v2 as PCI/spal-pubin/v1 (added spend_ref_hash, "
                "renamed policy_hash to policy_content_hash) before any implementation existed"
            ),
            "spal/payment/v1": (
                "reserved; superseded by v2 as PCI/spal-payment/v1 (currency became a "
                "variable-length chain-settlement field) before any implementation existed"
            ),
            "PCI/spal-commit/v1": (
                "renamed to spal/commit/v1 (#55); shipped in freehold-preimage 0.2.0"
            ),
            "PCI/spal-pubin/v2": (
                "renamed to spal/pubin/v2 (#55); shipped in freehold-preimage 0.2.0 "
                "and contracts 0.2.0"
            ),
            "PCI/spal-payment/v2": (
                "renamed to spal/payment/v2 (#55); shipped in freehold-preimage 0.2.0 "
                "and contracts 0.2.0"
            ),
            "PCI/did-envelope/v1": (
                "renamed to spal/did-envelope/v1 (#55); shipped in the 0.2.0 releases of "
                "freehold-preimage and freehold-agent"
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
            _text_field_rule(),
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
