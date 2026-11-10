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
 * This package encodes three structures: the DID authorization record,
 * `spal/did-authorization/v2`, which links an ephemeral DID to its root; the
 * DID approval attestation, `spal/did-approval/v1`, by which the holder of an
 * ephemeral DID approves one verification request; and the terms receipt,
 * `spal/receipt/v1`, which an operator (not the holder) signs for one request
 * it served under a terms hash.
 */

import type { AuthorizationRecord } from "./did.js"

/** Registry entry for the DID authorization record structure. */
export const DID_AUTHORIZATION_DOMAIN_SEPARATOR = "spal/did-authorization/v2"

/** Registry entry for the DID approval attestation structure. */
export const DID_APPROVAL_DOMAIN_SEPARATOR = "spal/did-approval/v1"

/** The terms receipt structure, `spal/receipt/v1` (spec/protocols/terms-receipt.md). */
export const RECEIPT_DOMAIN_SEPARATOR = "spal/receipt/v1"

/** Largest variable-length field the 4-byte length prefix can describe. */
export const MAX_VARIABLE_FIELD_LENGTH = 0xffffffff

/** One field of a preimage, in schema order. */
export type PreimageField =
  | { kind: "var"; bytes: Uint8Array }
  | { kind: "fixed"; bytes: Uint8Array; width: number }

/** The signed part of an authorization record: everything but the signature. */
export type AuthorizationRecordData = Omit<AuthorizationRecord, "rootSignature">

/** The fields of a terms receipt, in the operator's own words; the signature is separate. */
export interface TermsReceiptFields {
  operatorDid: string
  /** SHA-256 of the terms' canonical JSON, 32 bytes. */
  termsHash: Uint8Array
  /** SHA-256 of the request bytes served, 32 bytes. */
  requestHash: Uint8Array
  /** 16 bytes the holder's agent minted for this one request and sent with it. */
  nonce: Uint8Array
  /** The operator's own handle for the request; may be empty. */
  requestId: string
  /** Unix seconds. */
  servedAt: number
  /** The custody level the operator ran at, as text. */
  custody: string
  retentionSeconds: number
  training: string
  aggregation: string
  resale: string
}

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

/**
 * A getter can return a different value every time it is read, so a record
 * whose metadata carries one could sign one thing and verify another.
 */
function rejectAccessor(owner: object, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (descriptor && (descriptor.get || descriptor.set)) {
    throw new TypeError(
      `canonical JSON cannot represent an accessor property (${key})`,
    )
  }
}

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
 * undefined array element or hole becomes `null`, as `JSON.stringify` does and
 * as a storage round trip would leave them. Anything else is rejected rather
 * than coerced or dropped: a function or symbol anywhere is not JSON data, an
 * accessor property could read differently at verification, a non-finite
 * number has no canonical form, a string or key with a lone surrogate is not
 * Unicode text (RFC 8785 rejects it, where `JSON.stringify` would escape it),
 * and an object with a prototype other than `Object` (a `Date`, a class
 * instance) would serialise differently before and after a storage round trip,
 * so a record carrying one could never verify reliably.
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
    // A hole or an undefined element renders as null, as JSON.stringify does;
    // Array.from visits holes where map would skip them
    const elements: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      rejectAccessor(value, String(index))
      const entry = value[index]
      elements.push(entry === undefined ? "null" : canonicalJson(entry))
    }
    return `[${elements.join(",")}]`
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
      wellFormed(key, "JSON key")
      rejectAccessor(source, key)
      const entry = source[key]
      if (entry !== undefined) {
        members.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`)
      }
    }
    return `{${members.join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Encode a text field.
 *
 * Text fields follow the spec's text-field rule: UTF-8 as given, no
 * byte-order mark, well-formed only, no normalisation. The checks keep the
 * encoding injective. `TextEncoder` would coerce a number or an object to its
 * string form, so a record deserialised with the wrong type in a field would
 * sign or verify as if it carried that string; and it replaces a lone
 * surrogate with U+FFFD, so two different strings would encode to the same
 * bytes. A leading U+FEFF cannot be told apart from a byte-order mark.
 */
function text(value: unknown, name: string): PreimageField {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string, got ${typeof value}`)
  }
  if (value.startsWith("\uFEFF")) {
    // Indistinguishable from a byte-order mark; the spec's text-field rule rejects it
    throw new TypeError(`${name} must not begin with U+FEFF (byte-order mark)`)
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
 * The canonical preimage of an authorization record, `spal/did-authorization/v2`.
 *
 * Field order follows the spec; the context keys it covers are also listed as
 * `SIGNED_CONTEXT_KEYS` in did.ts, which serialisation and verification use.
 * Timestamps are the ISO 8601 text as recorded,
 * optional context fields are empty when absent (`metadata` also when null),
 * `metadata` is carried as canonical JSON so key order cannot change the
 * signed bytes, and `rootKeyId` is empty when the record names no binding.
 * Only the listed fields are signed; serialisation keeps a record's context
 * to those fields, so nothing unsigned travels with it.
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
    optionalText(record.rootKeyId, "rootKeyId"),
  ])
}

/**
 * The canonical preimage of an approval attestation, `spal/did-approval/v1`:
 * the request being approved and the ephemeral DID whose key signs. The
 * request id is opaque text as the agent issued it; a verifier compares it
 * with the request it holds, nothing more.
 *
 * Throws when either value is not text the encoding accepts.
 */
export function approvalPreimage(
  requestId: string,
  requesterDid: string,
): Uint8Array {
  return encodePreimage([
    text(DID_APPROVAL_DOMAIN_SEPARATOR, "domain_sep"),
    text(requestId, "requestId"),
    text(requesterDid, "requesterDid"),
  ])
}

/**
 * The canonical preimage of a terms receipt, `spal/receipt/v1`: what an
 * operator signs for one request it served under a terms hash. The two
 * hashes are opaque 32-byte inputs; the times and the retention are unsigned
 * 64-bit integers; the custody level and the three derivative permissions
 * are the text of their values.
 *
 * Throws a RangeError when a hash or the nonce is not its pinned width, and
 * a TypeError when an integer is negative, fractional or beyond the safe
 * range, or a text value is one the encoding cannot carry.
 */
export function receiptPreimage(receipt: TermsReceiptFields): Uint8Array {
  return encodePreimage([
    text(RECEIPT_DOMAIN_SEPARATOR, "domain_sep"),
    text(receipt.operatorDid, "operatorDid"),
    fixed(receipt.termsHash, 32, "termsHash"),
    fixed(receipt.requestHash, 32, "requestHash"),
    fixed(receipt.nonce, 16, "nonce"),
    text(receipt.requestId, "requestId"),
    uint64(receipt.servedAt, "servedAt"),
    text(receipt.custody, "custody"),
    uint64(receipt.retentionSeconds, "retentionSeconds"),
    text(receipt.training, "training"),
    text(receipt.aggregation, "aggregation"),
    text(receipt.resale, "resale"),
  ])
}

function fixed(bytes: Uint8Array, width: number, name: string): PreimageField {
  if (!(bytes instanceof Uint8Array) || bytes.length !== width) {
    throw new RangeError(`${name} must be ${width} bytes`)
  }
  return { kind: "fixed", bytes, width }
}

function uint64(value: number, name: string): PreimageField {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
  return { kind: "fixed", bytes, width: 8 }
}
