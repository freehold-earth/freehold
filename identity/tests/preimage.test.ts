import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  type AuthorizationContext,
  deserializeAuthorizationRecord,
  generateAuthorizedEphemeralDID,
  generateDID,
  isAuthorizationExpired,
  serializeAuthorizationRecord,
  signWithDID,
  verifyAuthorizationRecord,
} from "../src/did.js"
import {
  type AuthorizationRecordData,
  approvalPreimage,
  authorizationPreimage,
  canonicalJson,
  DID_APPROVAL_DOMAIN_SEPARATOR,
  DID_AUTHORIZATION_DOMAIN_SEPARATOR,
  encodePreimage,
  type PreimageField,
} from "../src/preimage.js"

interface VectorField {
  name: string
  kind: "var" | "fixed"
  value_utf8?: string
  value_hex?: string
  width?: number
}

interface Vector {
  name: string
  structure: string
  encoding_hex: string
  fields: VectorField[]
}

interface Adversarial {
  name: string
  raw_concat_a_hex: string
  raw_concat_b_hex: string
  encoding_a_hex: string
  encoding_b_hex: string
}

const spec = JSON.parse(
  readFileSync(
    new URL(
      "../../spec/schemas/encoding/v1.0/test-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  domain_separator_registry: Record<string, string>
  vectors: Vector[]
  adversarial: Adversarial[]
  validation: Array<{
    name: string
    must_reject?: Array<{
      name: string
      code_points?: string[]
      bytes_hex?: string
    }>
  }>
}

// The rule's byte-level cases (bytes_hex) are for decoders; this package only
// encodes, so they are exercised by the spec's Python decoder. A TypeScript
// decoder would have to consume them too.
const textRule = spec.validation.find(
  (rule) => rule.name === "text-field-encoding",
)
const rejectedTexts = (textRule?.must_reject ?? [])
  .filter((entry) => entry.code_points !== undefined)
  .map((entry) => ({
    name: entry.name,
    text: String.fromCodePoint(
      ...(entry.code_points ?? []).map((point) =>
        Number.parseInt(point.slice(2), 16),
      ),
    ),
  }))

const utf8 = new TextEncoder()

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  )
}

function fieldFromVector(entry: VectorField): PreimageField {
  if (entry.kind === "var") {
    return {
      kind: "var",
      bytes:
        entry.value_utf8 !== undefined
          ? utf8.encode(entry.value_utf8)
          : fromHex(entry.value_hex ?? ""),
    }
  }
  return {
    kind: "fixed",
    bytes: fromHex(entry.value_hex ?? ""),
    width: entry.width ?? 0,
  }
}

function vars(...parts: string[]): PreimageField[] {
  return parts.map((part) => ({ kind: "var", bytes: utf8.encode(part) }))
}

describe("canonical preimage encoding", () => {
  it.each(spec.vectors)("reproduces the spec vector $name", (vector) => {
    const fields = vector.fields.map(fieldFromVector)
    expect(hex(encodePreimage(fields))).toBe(vector.encoding_hex)
  })

  it("registers the authorization record's domain separator", () => {
    expect(spec.domain_separator_registry).toHaveProperty(
      DID_AUTHORIZATION_DOMAIN_SEPARATOR,
    )
  })

  it("registers the approval attestation's domain separator", () => {
    expect(spec.domain_separator_registry).toHaveProperty(
      DID_APPROVAL_DOMAIN_SEPARATOR,
    )
  })

  it("reproduces the spec vector for an approval attestation", () => {
    const vector = spec.vectors.find((v) => v.name === "did-approval-age-check")
    expect(vector).toBeDefined()
    expect(
      hex(
        approvalPreimage(
          "6f1d2c3b-4a5e-4f60-8a71-9b82c3d4e5f6",
          "did:key:z6Mkephemeral456",
        ),
      ),
    ).toBe(vector?.encoding_hex)
  })

  it("rejects an approval over text the encoding cannot carry", () => {
    expect(() => approvalPreimage("req", "did:key:z\uD800")).toThrow(TypeError)
    expect(() => approvalPreimage("\uFEFFreq", "did:key:zabc")).toThrow(
      TypeError,
    )
  })

  it("emits an empty variable-length field with its length prefix", () => {
    expect(hex(encodePreimage(vars("")))).toBe("00000000")
  })

  it("rejects a fixed-width field of the wrong width", () => {
    expect(() =>
      encodePreimage([{ kind: "fixed", bytes: new Uint8Array(31), width: 32 }]),
    ).toThrow(RangeError)
  })

  it("keeps a DID boundary move distinct, as the spec's adversarial case shows", () => {
    const a = vars(
      DID_AUTHORIZATION_DOMAIN_SEPARATOR,
      "did:key:z6MkA",
      "BCDdid:key:z6MkRoot",
    )
    const b = vars(
      DID_AUTHORIZATION_DOMAIN_SEPARATOR,
      "did:key:z6MkABCD",
      "did:key:z6MkRoot",
    )
    const published = spec.adversarial.find(
      (c) => c.name === "did-authorization-did-boundary-move",
    )
    expect(published).toBeDefined()
    expect(published?.raw_concat_a_hex).toBe(published?.raw_concat_b_hex)
    expect(hex(encodePreimage(a))).toBe(published?.encoding_a_hex)
    expect(hex(encodePreimage(b))).toBe(published?.encoding_b_hex)
    expect(hex(encodePreimage(a))).not.toBe(hex(encodePreimage(b)))
  })
})

describe("canonical JSON", () => {
  it("sorts keys at every level and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null, "x"], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[true,null,"x"]},"b":1}',
    )
  })

  it("omits undefined properties and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: 0 })).toBe('{"b":0}')
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError)
  })

  it("serialises a __proto__ key as an ordinary member instead of dropping it", () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"a":1}')
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"admin":true},"a":1}')
  })

  it("renders array holes as null instead of skipping them", () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point of the test
    expect(canonicalJson([1, , 3])).toBe("[1,null,3]")
    expect(canonicalJson(new Array(2))).toBe("[null,null]")
  })

  it("rejects a lone surrogate in a JSON string or key", () => {
    expect(() => canonicalJson({ a: "\uD800" })).toThrow(TypeError)
    expect(() => canonicalJson({ "\uDC00": 1 })).toThrow(TypeError)
  })

  it("rejects function and symbol members instead of dropping them", () => {
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError)
    expect(() => canonicalJson({ a: Symbol("s") })).toThrow(TypeError)
    expect(() => canonicalJson([() => 1])).toThrow(TypeError)
    expect(() => canonicalJson({ "\uD800": () => 1 })).toThrow(TypeError)
  })

  it("rejects accessor properties, whose value could differ at verification", () => {
    const flapping = { reads: 0 }
    const withGetter = Object.defineProperty({}, "a", {
      enumerable: true,
      get: () => (flapping.reads += 1),
    })
    expect(() => canonicalJson(withGetter)).toThrow(TypeError)
    const array = Object.defineProperty([1], "0", {
      enumerable: true,
      get: () => 2,
    })
    expect(() => canonicalJson(array)).toThrow(TypeError)
  })

  it("rejects objects with a prototype other than Object, such as Date", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(TypeError)
    expect(canonicalJson({ at: Object.create(null) })).toBe('{"at":{}}')
    expect(canonicalJson([undefined])).toBe("[null]")
  })

  it("matches JSON.stringify on already-canonical input", () => {
    const value = { a: [1, "two", false, null, { b: 2.5, c: "é\n" }], d: {} }
    expect(canonicalJson(value)).toBe(JSON.stringify(value))
  })
})

describe("authorization record preimage", () => {
  const vectorRecord: AuthorizationRecordData = {
    ephemeralDid: "did:key:z6Mkephemeral456",
    rootDid: "did:key:z6Mkroot123",
    purpose: "Age verification at a shop",
    context: {
      verificationType: "age_over_18",
      verifierDid: "did:web:shop.example",
      metadata: { channel: "in-store" },
    },
    timestamp: "2026-11-03T10:30:00.000Z",
    expiresAt: "2026-11-03T11:30:00.000Z",
  }

  it("reproduces the spec vector from a record", () => {
    const vector = spec.vectors.find(
      (v) => v.name === "did-authorization-age-check",
    )
    expect(vector).toBeDefined()
    expect(hex(authorizationPreimage(vectorRecord))).toBe(vector?.encoding_hex)
  })

  it("reproduces the spec vector for an external root naming its binding", () => {
    const vector = spec.vectors.find(
      (v) => v.name === "did-authorization-atproto-root",
    )
    expect(vector).toBeDefined()
    const record: AuthorizationRecordData = {
      ephemeralDid: "did:key:z6Mkephemeral456",
      rootDid: "did:plc:exampleroot2345abcdefghi",
      purpose: "Age verification at a shop",
      context: { verificationType: "age_over_18" },
      timestamp: "2026-11-03T10:30:00.000Z",
      rootKeyId: "bafyreiexamplerootkeybindingrecordcid2345abcdefghijklmnopq",
    }
    expect(hex(authorizationPreimage(record))).toBe(vector?.encoding_hex)
  })

  it("does not depend on metadata key order", () => {
    const reordered: AuthorizationRecordData = {
      ...vectorRecord,
      context: {
        ...vectorRecord.context,
        metadata: { z: { b: 1, a: 2 }, a: [1, 2] },
      },
    }
    const original: AuthorizationRecordData = {
      ...vectorRecord,
      context: {
        ...vectorRecord.context,
        metadata: { a: [1, 2], z: { a: 2, b: 1 } },
      },
    }
    expect(hex(authorizationPreimage(reordered))).toBe(
      hex(authorizationPreimage(original)),
    )
  })

  it("rejects a record missing a required field rather than signing it as empty", () => {
    const missing = { ...vectorRecord, purpose: undefined as unknown as string }
    expect(() => authorizationPreimage(missing)).toThrow(TypeError)
  })

  it("rejects a record whose text field is not a string", () => {
    const wrongType = {
      ...vectorRecord,
      context: { ...vectorRecord.context, verifierDid: 5 as unknown as string },
    }
    expect(() => authorizationPreimage(wrongType)).toThrow(TypeError)
  })

  it.each(rejectedTexts)("rejects the spec's must-reject text case $name", ({
    text,
  }) => {
    expect(() =>
      authorizationPreimage({ ...vectorRecord, purpose: text }),
    ).toThrow(TypeError)
  })

  it("covers every text rejection case the spec gives as code points", () => {
    expect(rejectedTexts.map((entry) => entry.name)).toEqual([
      "leading-bom",
      "lone-surrogate",
    ])
  })

  it("rejects a text field that begins with a byte-order mark", () => {
    const bom = { ...vectorRecord, purpose: "\uFEFFAge verification" }
    expect(() => authorizationPreimage(bom)).toThrow(TypeError)
    const inside = { ...vectorRecord, purpose: "Age\uFEFFverification" }
    expect(() => authorizationPreimage(inside)).not.toThrow()
  })

  it("signs text as given, so NFC and NFD forms of a purpose differ", () => {
    const nfc = { ...vectorRecord, purpose: "caf\u00e9" }
    const nfd = { ...vectorRecord, purpose: "cafe\u0301" }
    expect(hex(authorizationPreimage(nfc))).not.toBe(
      hex(authorizationPreimage(nfd)),
    )
  })

  it("rejects a text field that is not well-formed UTF-16", () => {
    const loneSurrogate = { ...vectorRecord, purpose: "bad \uD800 text" }
    expect(() => authorizationPreimage(loneSurrogate)).toThrow(TypeError)
    const paired = { ...vectorRecord, purpose: "ok \uD83D\uDE00 text" }
    expect(() => authorizationPreimage(paired)).not.toThrow()
  })

  it("encodes null metadata as the empty field, like absent metadata", () => {
    const absent = { ...vectorRecord, context: { verificationType: "t" } }
    const nulled = {
      ...vectorRecord,
      context: { verificationType: "t", metadata: null },
    }
    expect(hex(authorizationPreimage(nulled as AuthorizationRecordData))).toBe(
      hex(authorizationPreimage(absent)),
    )
  })

  it("carries absent optional fields as empty fields, not omitted ones", () => {
    const minimal: AuthorizationRecordData = {
      ephemeralDid: "did:key:z6MkE",
      rootDid: "did:key:z6MkR",
      purpose: "p",
      context: { verificationType: "t" },
      timestamp: "2026-01-01T00:00:00Z",
    }
    const explicit: AuthorizationRecordData = {
      ...minimal,
      context: { verificationType: "t", verifierDid: "", policyHash: "" },
      expiresAt: "",
      rootKeyId: "",
    }
    expect(hex(authorizationPreimage(minimal))).toBe(
      hex(authorizationPreimage(explicit)),
    )
    // 11 fields, each with a 4-byte prefix
    expect(authorizationPreimage(minimal).length).toBe(
      11 * 4 +
        DID_AUTHORIZATION_DOMAIN_SEPARATOR.length +
        "did:key:z6MkE".length +
        "did:key:z6MkR".length +
        1 +
        1 +
        "2026-01-01T00:00:00Z".length,
    )
  })
})

describe("re-partitioned authorization records are rejected", () => {
  it("does not verify a record whose DID boundary was moved under a valid signature", async () => {
    const root = await generateDID()
    const timestamp = new Date().toISOString()
    // A: the root signs an ephemeral DID that ends where the next field begins
    const signed: AuthorizationRecordData = {
      ephemeralDid: "did:key:z6MkA",
      rootDid: `BCD${root.did}`,
      purpose: "boundary",
      context: { verificationType: "age_over_18" },
      timestamp,
    }
    // B: the same bytes under raw concatenation, with the boundary moved
    const forged: AuthorizationRecordData = {
      ...signed,
      ephemeralDid: "did:key:z6MkABCD",
      rootDid: root.did,
    }
    expect(signed.ephemeralDid + signed.rootDid).toBe(
      forged.ephemeralDid + forged.rootDid,
    )
    expect(hex(authorizationPreimage(signed))).not.toBe(
      hex(authorizationPreimage(forged)),
    )

    const rootSignature = await signWithDID(
      root.privateKey,
      authorizationPreimage(signed),
    )
    expect(await verifyAuthorizationRecord({ ...forged, rootSignature })).toBe(
      false,
    )
  })

  it("returns false, not an exception, for a malformed stored record", async () => {
    const root = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      root,
      "malformed",
      {
        verificationType: "t",
      },
    )
    const loneSurrogate = { ...authorization, purpose: "\uD800" }
    expect(await verifyAuthorizationRecord(loneSurrogate)).toBe(false)
    const wrongType = {
      ...authorization,
      context: { verificationType: 5 as unknown as string },
    }
    expect(await verifyAuthorizationRecord(wrongType)).toBe(false)
    const noContext = {
      ...authorization,
      context: undefined as unknown as AuthorizationContext,
    }
    expect(await verifyAuthorizationRecord(noContext)).toBe(false)
    const badExpiry = { ...authorization, expiresAt: "2026-13-99" }
    expect(await verifyAuthorizationRecord(badExpiry)).toBe(false)
    expect(isAuthorizationExpired(badExpiry)).toBe(true)
    const shortSignature = {
      ...authorization,
      rootSignature: new Uint8Array(3),
    }
    expect(await verifyAuthorizationRecord(shortSignature)).toBe(false)
    const symbolExpiry = {
      ...authorization,
      expiresAt: Symbol("never") as unknown as string,
    }
    expect(await verifyAuthorizationRecord(symbolExpiry)).toBe(false)
    const numericRoot = { ...authorization, rootDid: 42 as unknown as string }
    expect(await verifyAuthorizationRecord(numericRoot)).toBe(false)
  })

  it("does not verify a record whose metadata holds a function member", async () => {
    const root = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      root,
      "non-json",
      {
        verificationType: "t",
        metadata: { a: 1 },
      },
    )
    const withFunction = {
      ...authorization,
      context: { ...authorization.context, metadata: { a: 1, b: () => 2 } },
    }
    expect(await verifyAuthorizationRecord(withFunction)).toBe(false)
  })

  it("does not verify a record carrying a context key the signature never covered", async () => {
    const root = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      root,
      "unsigned key",
      {
        verificationType: "t",
      },
    )
    expect(await verifyAuthorizationRecord(authorization)).toBe(true)
    const withExtra = {
      ...authorization,
      context: {
        ...authorization.context,
        scope: "admin",
      } as AuthorizationContext,
    }
    expect(await verifyAuthorizationRecord(withExtra)).toBe(false)
  })

  it("keeps the generated record's context to the signed fields", async () => {
    const root = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      root,
      "normalised",
      {
        verificationType: "t",
        scope: "admin",
      } as AuthorizationContext,
    )
    expect(authorization.context).toEqual({ verificationType: "t" })
  })

  it("drops context keys the signature does not cover when a record is stored", async () => {
    const root = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      root,
      "extra keys",
      {
        verificationType: "t",
      },
    )
    const withExtra = {
      ...authorization,
      context: {
        ...authorization.context,
        scope: "read",
      } as AuthorizationContext,
    }
    const stored = serializeAuthorizationRecord(withExtra)
    expect(stored.context).toEqual({ verificationType: "t" })
    expect(deserializeAuthorizationRecord(stored).context).not.toHaveProperty(
      "scope",
    )
  })

  it("verifies a genuine record after a round trip that reorders metadata keys", async () => {
    const root = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      root,
      "metadata order",
      {
        verificationType: "employment_status",
        metadata: { z: 1, a: { d: 2, c: 3 } },
      },
    )
    const serialized = serializeAuthorizationRecord(authorization)
    const reordered = deserializeAuthorizationRecord({
      ...serialized,
      context: { ...serialized.context, metadata: { a: { c: 3, d: 2 }, z: 1 } },
    })
    expect(await verifyAuthorizationRecord(reordered)).toBe(true)
  })
})
