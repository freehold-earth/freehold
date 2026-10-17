"""Reference implementation of the PCI canonical preimage encoding.

The encoding is specified in ``protocols/preimage-encoding.md`` and guarantees
injectivity: no two distinct field tuples serialize to the same bytes. It is
deliberately hash-agnostic — this package produces the bytes that are hashed,
never a digest.
"""

from pci_preimage.encoding import (
    MAX_VARIABLE_FIELD_LENGTH,
    DecodeError,
    Field,
    FieldKind,
    FieldSpec,
    FieldTooLongError,
    FixedField,
    FixedWidthError,
    PreimageError,
    VariableField,
    decode,
    encode,
)
from pci_preimage.structures import (
    CARDANO_MAX_ASSET_NAME_LENGTH,
    CARDANO_POLICY_ID_WIDTH,
    DID_SIGNED_REQUEST_ENVELOPE,
    PAYMENT_COMMITMENT,
    SPAL_POLICY_COMMITMENT,
    SPAL_ZK_PUBLIC_INPUT,
    STRUCTURES,
    CurrencyError,
    CurrencyTag,
    Structure,
    validate_currency,
    validate_fields,
)

__all__ = [
    "CARDANO_MAX_ASSET_NAME_LENGTH",
    "CARDANO_POLICY_ID_WIDTH",
    "DID_SIGNED_REQUEST_ENVELOPE",
    "MAX_VARIABLE_FIELD_LENGTH",
    "PAYMENT_COMMITMENT",
    "SPAL_POLICY_COMMITMENT",
    "SPAL_ZK_PUBLIC_INPUT",
    "STRUCTURES",
    "CurrencyError",
    "CurrencyTag",
    "DecodeError",
    "Field",
    "FieldKind",
    "FieldSpec",
    "FieldTooLongError",
    "FixedField",
    "FixedWidthError",
    "PreimageError",
    "Structure",
    "VariableField",
    "decode",
    "encode",
    "validate_currency",
    "validate_fields",
]
