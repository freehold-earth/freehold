"""Core canonical preimage encoding: field types, encoder, and decoder.

Implements the encoding rule from ``protocols/preimage-encoding.md``: a
variable-length field is emitted as a 4-byte big-endian length prefix followed
by its raw bytes; a fixed-width field is emitted raw at its schema-pinned
width. The domain separator is simply the first variable-length field. The
result is injective: no two distinct field tuples serialize to the same bytes.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

MAX_VARIABLE_FIELD_LENGTH = 0xFFFFFFFF
_LENGTH_PREFIX_WIDTH = 4


class PreimageError(Exception):
    """Base error for canonical preimage encoding and decoding failures."""


class FieldTooLongError(PreimageError):
    """A variable-length field is longer than the uint32 length-prefix maximum."""


class FixedWidthError(PreimageError):
    """A fixed-width field's value does not match its schema-pinned width."""


class DecodeError(PreimageError):
    """Encoded bytes do not decode cleanly against the given field schema."""


class TextEncodingError(PreimageError):
    """A text value is not well-formed, BOM-free Unicode and cannot become a field."""


@dataclass(frozen=True)
class VariableField:
    """A variable-length field, emitted with a 4-byte big-endian length prefix."""

    value: bytes


@dataclass(frozen=True)
class FixedField:
    """A fixed-width field, emitted raw at its schema-pinned width."""

    value: bytes
    width: int


Field = VariableField | FixedField


class FieldKind(Enum):
    """Whether a field is length-prefixed (variable) or raw at a pinned width (fixed)."""

    VARIABLE = "var"
    FIXED = "fixed"


@dataclass(frozen=True)
class FieldSpec:
    """Schema entry naming one field and pinning its kind and, for fixed fields, width."""

    name: str
    kind: FieldKind
    width: int | None = None

    def __post_init__(self) -> None:
        """Enforce that width is pinned exactly when the field is fixed-width.

        Raises:
            ValueError: A fixed-width spec has no positive width, or a
                variable-length spec pins one.
        """
        if self.kind is FieldKind.FIXED:
            if self.width is None or self.width <= 0:
                raise ValueError(f"fixed-width field '{self.name}' requires a positive width")
        elif self.width is not None:
            raise ValueError(f"variable-length field '{self.name}' must not pin a width")


def encode(fields: Sequence[Field]) -> bytes:
    """Encode an ordered field tuple into its canonical injective byte form.

    Args:
        fields: Fields in schema-defined order; the domain separator is the
            first field and is itself a ``VariableField``.

    Returns:
        The canonical encoding: each variable-length field length-prefixed,
        each fixed-width field raw at its pinned width.

    Raises:
        FieldTooLongError: A variable-length field is longer than
            ``MAX_VARIABLE_FIELD_LENGTH`` bytes; such a field is rejected,
            never wrapped or truncated.
        FixedWidthError: A fixed-width field's value is not exactly its
            declared width.
    """
    out = bytearray()
    for field in fields:
        if isinstance(field, VariableField):
            length = len(field.value)
            if length > MAX_VARIABLE_FIELD_LENGTH:
                raise FieldTooLongError(
                    f"variable-length field of {length} bytes exceeds the "
                    f"maximum of {MAX_VARIABLE_FIELD_LENGTH} bytes"
                )
            out += length.to_bytes(_LENGTH_PREFIX_WIDTH, "big")
            out += field.value
        else:
            if len(field.value) != field.width:
                raise FixedWidthError(
                    f"fixed-width field must be exactly {field.width} bytes, got {len(field.value)}"
                )
            out += field.value
    return bytes(out)


def encode_text(value: str) -> bytes:
    """Turn a text value into the bytes of a variable-length field.

    Text fields are the UTF-8 bytes of the value as given: no byte-order mark,
    and no Unicode normalisation. Two values that look alike but differ in code
    points are different values and encode differently; the layer that defines
    an identifier's equality normalises before the text reaches the encoder.

    Args:
        value: The text as presented by the signer.

    Returns:
        The UTF-8 encoding of ``value``.

    Raises:
        TextEncodingError: ``value`` contains a lone surrogate, so it is not a
            sequence of Unicode scalar values and has no UTF-8 form (it is
            rejected, never replaced with U+FFFD), or it begins with U+FEFF,
            which cannot be told apart from a byte-order mark.
    """
    if value.startswith("\ufeff"):
        raise TextEncodingError("text field must not begin with U+FEFF (byte-order mark)")
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise TextEncodingError("text field is not well-formed Unicode (lone surrogate)") from error


def decode_text(value: bytes) -> str:
    """Read a text field's bytes back into text, under the same rule as ``encode_text``.

    Args:
        value: The bytes of a variable-length field that carries text.

    Returns:
        The text the bytes encode.

    Raises:
        TextEncodingError: The bytes are not well-formed UTF-8 (an invalid
            sequence, or a surrogate code point encoded as if it were a scalar
            value), or they begin with the byte-order mark.
    """
    try:
        text = value.decode("utf-8")
    except UnicodeDecodeError as error:
        raise TextEncodingError("text field bytes are not well-formed UTF-8") from error
    # Mirrors the encoder's rule: a leading U+FEFF is rejected whether it was a
    # byte-order mark or content, because the two cannot be told apart.
    if text.startswith("\ufeff"):
        raise TextEncodingError("text field must not begin with U+FEFF (byte-order mark)")
    return text


def decode(data: bytes, schema: Sequence[FieldSpec]) -> tuple[bytes, ...]:
    """Decode a canonical encoding back into its ordered field values.

    Constructively re-derives the field tuple, demonstrating that the encoding
    admits exactly one parse under the schema: every byte is consumed and every
    boundary is fixed by a length prefix or a pinned width.

    Args:
        data: The canonical encoding to decode.
        schema: Field specs in schema-defined order.

    Returns:
        The decoded field values, one per spec, in schema order.

    Raises:
        DecodeError: The data ends inside a length prefix or field, or
            trailing bytes remain after the final field.
    """
    values: list[bytes] = []
    offset = 0
    for spec in schema:
        if spec.kind is FieldKind.VARIABLE:
            prefix_end = offset + _LENGTH_PREFIX_WIDTH
            if prefix_end > len(data):
                raise DecodeError(f"data ends inside the length prefix of field '{spec.name}'")
            length = int.from_bytes(data[offset:prefix_end], "big")
            offset = prefix_end
            end = offset + length
        else:
            assert spec.width is not None
            end = offset + spec.width
        if end > len(data):
            raise DecodeError(f"data ends before the end of field '{spec.name}'")
        values.append(data[offset:end])
        offset = end
    if offset != len(data):
        raise DecodeError(f"{len(data) - offset} trailing byte(s) after the final field")
    return tuple(values)
