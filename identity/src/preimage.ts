/**
 * Canonical preimage encoding for signed structures.
 *
 * Implements the encoding rule of spec/protocols/preimage-encoding.md: every
 * variable-length field carries a 4-byte big-endian length prefix, fixed-width
 * fields are emitted raw at their pinned width, and a registered domain
 * separator is the first field. Two different field tuples can never encode to
 * the same bytes, so no re-partitioning of a DID or any other variable-length
 * identifier yields a second structure that one signature authorises (ADR-007).
 *
 * The one structure this package signs is the DID authorization record,
 * `spal/did-authorization/v1`, which links an ephemeral DID to its root.
 */

import type { AuthorizationRecord } from "./did.js"

/** Registry entry for the DID authorization record structure. */
export const DID_AUTHORIZATION_DOMAIN_SEPARATOR = "spal/did-authorization/v1"

/** Largest variable-length field the 4-byte length prefix can describe. */
export const MAX_VARIABLE_FIELD_LENGTH = 0xffffffff

/** One field of a preimage, in schema order. */
export type PreimageField =
  | { kind: "var"; bytes: Uint8Array }
  | { kind: "fixed"; bytes: Uint8Array; width: number }

/** The signed part of an authorization record: everything but the signature. */
export type AuthorizationRecordData = Omit<AuthorizationRecord, "rootSignature">

const utf8 = new TextEncoder()

/**
 * Encode fields into their canonical preimage bytes.
 *
 * Rejects, never coerces: a variable-length field over the maximum or a
 * fixed-width field of the wrong width throws, because wrapping or padding
 * would reintroduce the ambiguity the encoding exists to remove.
 */
export function encodePreimage(fields: readonly PreimageField[]): Uint8Array {
  let total = 0
  for (const field of fields) {
    if (field.kind === "var") {
      if (field.bytes.length > MAX_VARIABLE_FIELD_LENGTH) {
        throw new RangeError(
          `variable-length field of ${field.bytes.length} bytes exceeds the ${MAX_VARIABLE_FIELD_LENGTH}-byte maximum`,
        )
      }
      total += 4 + field.bytes.length
    } else {
      if (field.bytes.length !== field.width) {
        throw new RangeError(
          `fixed-width field is ${field.bytes.length} bytes but the schema pins ${field.width}`,
        )
      }
      total += field.width
    }
  }

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  let offset = 0
  for (const field of fields) {
    if (field.kind === "var") {
      view.setUint32(offset, field.bytes.length, false)
      offset += 4
    }
    out.set(field.bytes, offset)
    offset += field.bytes.length
  }
  return out
}

// A UTF-16 surrogate that is not part of a pair. String.prototype.isWellFormed
// says the same thing but is ES2024, above the ES2022 lib this package builds against.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function wellFormed(value: string, what: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new TypeError(`${what} is not well-formed UTF-16 (lone surrogate)`)
  }
  return value
}

/**
 * Serialise JSON data in its RFC 8785 canonical form: object keys sorted by
 * UTF-16 code units, no insignificant whitespace, ES number formatting.
 *
 * Only JSON data is supported: strings, finite numbers, booleans, null, arrays
 * and plain objects. Properties whose value is `undefined` are omitted and an
 * array element that JSON cannot carry becomes `null`, as `JSON.stringify`
 * does. Anything else is rejected rather than coerced: a non-finite number has
 * no canonical form, a string or key with a lone surrogate is not Unicode text
 * (RFC 8785 rejects it, where `JSON.stringify` would escape it), and an object
 * with a prototype other than `Object` (a `Date`, a class instance) would
 * serialise differently before and after a storage round trip, so a record
 * carrying one could never verify reliably.
 */
export function canonicalJson(value: unknown): string {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError("canonical JSON cannot represent a non-JSON value")
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON cannot represent a non-finite number")
  }
  if (typeof value === "bigint") {
    throw new TypeError("canonical JSON cannot represent a bigint")
  }
  if (typeof value === "string") {
    return JSON.stringify(wellFormed(value, "JSON string"))
  }
  if (Array.isArray(value)) {
    // JSON.stringify renders an element it cannot carry, or a hole, as null;
    // Array.from visits holes where map would skip them
    return `[${Array.from(value, (entry) =>
      entry === undefined ||
      typeof entry === "function" ||
      typeof entry === "symbol"
        ? "null"
        : canonicalJson(entry),
    ).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "canonical JSON accepts only plain objects and arrays",
      )
    }
    // The text is built directly from the sorted entries rather than through an
    // intermediate object, so a key such as "__proto__" is serialised like any
    // other own property instead of being swallowed by object semantics.
    const source = value as Record<string, unknown>
    const members: string[] = []
    for (const key of Object.keys(source).sort()) {
      const entry = source[key]
      if (
        entry !== undefined &&
        typeof entry !== "function" &&
        typeof entry !== "symbol"
      ) {
        members.push(
          `${JSON.stringify(wellFormed(key, "JSON key"))}:${canonicalJson(entry)}`,
        )
      }
    }
    return `{${members.join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Encode a text field.
 *
 * Both checks keep the encoding injective. `TextEncoder` would coerce a
 * number or an object to its string form, so a record deserialised with the
 * wrong type in a field would sign or verify as if it carried that string; and
 * it replaces a lone surrogate with U+FFFD, so two different strings would
 * encode to the same bytes.
 */
function text(value: unknown, name: string): PreimageField {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string, got ${typeof value}`)
  }
  return { kind: "var", bytes: utf8.encode(wellFormed(value, name)) }
}

/** Encode an optional text field, empty when absent. */
function optionalText(value: unknown, name: string): PreimageField {
  return value === undefined
    ? { kind: "var", bytes: new Uint8Array(0) }
    : text(value, name)
}

/**
 * The canonical preimage of an authorization record, `spal/did-authorization/v1`.
 *
 * Field order follows the spec; the context keys it covers are also listed as
 * `SIGNED_CONTEXT_KEYS` in did.ts, which serialisation and verification use.
 * Timestamps are the ISO 8601 text as recorded,
 * optional context fields are empty when absent (`metadata` also when null),
 * and `metadata` is carried as canonical JSON so key order cannot change the
 * signed bytes. Only the listed fields are signed; serialisation keeps a
 * record's context to those fields, so nothing unsigned travels with it.
 *
 * Throws when a field cannot be encoded without coercion: a required field
 * that is missing, a non-string where text belongs, a lone surrogate, or
 * metadata that is not plain JSON data.
 */
export function authorizationPreimage(
  record: AuthorizationRecordData,
): Uint8Array {
  const { context } = record
  return encodePreimage([
    text(DID_AUTHORIZATION_DOMAIN_SEPARATOR, "domain_sep"),
    text(record.ephemeralDid, "ephemeralDid"),
    text(record.rootDid, "rootDid"),
    text(record.purpose, "purpose"),
    text(context.verificationType, "context.verificationType"),
    optionalText(context.verifierDid, "context.verifierDid"),
    optionalText(context.policyHash, "context.policyHash"),
    text(
      context.metadata == null ? "" : canonicalJson(context.metadata),
      "context.metadata",
    ),
    text(record.timestamp, "timestamp"),
    optionalText(record.expiresAt, "expiresAt"),
  ])
}
