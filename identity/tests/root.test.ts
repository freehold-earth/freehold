import { describe, expect, it, vi } from "vitest"
import {
  type AuthorizationContext,
  generateAuthorizedEphemeralDID,
  generateDID,
  verifyAuthorizationRecord,
} from "../src/did.js"
import {
  createRootKeyResolver,
  didDocumentUrl,
  httpDidResolver,
  isBindingValidAt,
  parseRootKeyRecord,
  pdsEndpoint,
  ROOT_KEY_COLLECTION,
  type RootKeyBinding,
  type RootKeyResolver,
  rootKeyRecord,
  xrpcRecordFetcher,
} from "../src/root.js"

const PLC_DID = "did:plc:exampleroot2345abcdefghi"
const WEB_DID = "did:web:alice.example"
const CURRENT_CID = "bafyreicurrentbindingcid"
const OLD_CID = "bafyreioldbindingcid"

const context: AuthorizationContext = { verificationType: "age_over_18" }

async function bindingFor(
  publicKey: Uint8Array,
  cid: string,
  extra: Partial<RootKeyBinding> = {},
): Promise<RootKeyBinding> {
  return {
    cid,
    publicKey,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  }
}

/** A resolver over an in-memory map of bindings by DID and CID. */
function memoryResolver(
  bindings: Record<string, RootKeyBinding[]>,
): RootKeyResolver {
  return async (did, rootKeyId) => {
    const all = bindings[did] ?? []
    if (rootKeyId !== undefined) {
      return all.find((b) => b.cid === rootKeyId) ?? null
    }
    return all.at(-1) ?? null
  }
}

describe("authorization by an external root", () => {
  it("verifies a did:plc root against its published binding", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: CURRENT_CID },
      "Age verification",
      context,
    )
    expect(authorization.rootDid).toBe(PLC_DID)
    expect(authorization.rootKeyId).toBe(CURRENT_CID)

    const resolveRootKey = memoryResolver({
      [PLC_DID]: [await bindingFor(keyPair.publicKey, CURRENT_CID)],
    })
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(true)
  })

  it("verifies a did:web root the same way", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: WEB_DID, keyPair },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [WEB_DID]: [await bindingFor(keyPair.publicKey, CURRENT_CID)],
    })
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(true)
  })

  it("rejects a record whose root has no binding (revoked or never published)", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: CURRENT_CID },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({})
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(false)
  })

  it("rejects a record signed by a key other than the bound one", async () => {
    const keyPair = await generateDID()
    const other = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: CURRENT_CID },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [await bindingFor(other.publicKey, CURRENT_CID)],
    })
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(false)
  })

  it("rejects an expired binding", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: CURRENT_CID },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [
        await bindingFor(keyPair.publicKey, CURRENT_CID, {
          expiresAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
    })
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(false)
  })

  it("rejects a record naming a binding that has been replaced, unless historical keys are allowed", async () => {
    const oldKey = await generateDID()
    const newKey = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair: oldKey, rootKeyId: OLD_CID },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [
        await bindingFor(oldKey.publicKey, OLD_CID, {
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
        await bindingFor(newKey.publicKey, CURRENT_CID),
      ],
    })

    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(false)
    expect(
      await verifyAuthorizationRecord(authorization, {
        resolveRootKey,
        allowHistoricalKeys: true,
      }),
    ).toBe(true)
  })

  it("closes a historical binding at the moment it was superseded", async () => {
    const leaked = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair: leaked, rootKeyId: OLD_CID },
      "Age verification",
      context,
    )
    // The record is dated now, after the binding was replaced
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [
        await bindingFor(leaked.publicKey, OLD_CID, {
          supersededAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
    })
    expect(
      await verifyAuthorizationRecord(authorization, {
        resolveRootKey,
        allowHistoricalKeys: true,
      }),
    ).toBe(false)
  })

  it("rejects a record dated before its binding existed, or in the future, even against the current binding", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: CURRENT_CID },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [
        await bindingFor(keyPair.publicKey, CURRENT_CID, {
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    })
    const predating = {
      ...authorization,
      timestamp: "2025-01-01T00:00:00.000Z",
    }
    const future = { ...authorization, timestamp: "2099-01-01T00:00:00.000Z" }
    const garbled = { ...authorization, timestamp: "yesterday" }
    for (const record of [predating, future, garbled]) {
      expect(await verifyAuthorizationRecord(record, { resolveRootKey })).toBe(
        false,
      )
    }
  })

  it("still requires an unnamed binding to be in force now when historical keys are allowed", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [
        await bindingFor(keyPair.publicKey, CURRENT_CID, {
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    })
    expect(
      await verifyAuthorizationRecord(authorization, {
        resolveRootKey,
        allowHistoricalKeys: true,
      }),
    ).toBe(false)
  })

  it("rejects a did:key record that names a binding", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      keyPair,
      "Age verification",
      context,
    )
    const named = { ...authorization, rootKeyId: CURRENT_CID }
    expect(await verifyAuthorizationRecord(named)).toBe(false)
  })

  it("rejects a historical record dated in the future", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: OLD_CID },
      "Age verification",
      context,
    )
    const future = { ...authorization, timestamp: "2099-01-01T00:00:00.000Z" }
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [await bindingFor(keyPair.publicKey, OLD_CID)],
    })
    expect(
      await verifyAuthorizationRecord(future, {
        resolveRootKey,
        allowHistoricalKeys: true,
      }),
    ).toBe(false)
  })

  it("tolerates a binding created moments ahead of the verifier's clock", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: CURRENT_CID },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [
        await bindingFor(keyPair.publicKey, CURRENT_CID, {
          createdAt: new Date(Date.now() + 90_000).toISOString(),
        }),
      ],
    })
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(true)
  })

  it("rejects a historical binding that was not yet valid when the record was issued", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair, rootKeyId: OLD_CID },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [
        await bindingFor(keyPair.publicKey, OLD_CID, {
          createdAt: "2099-01-01T00:00:00.000Z",
        }),
      ],
    })
    expect(
      await verifyAuthorizationRecord(authorization, {
        resolveRootKey,
        allowHistoricalKeys: true,
      }),
    ).toBe(false)
  })

  it("rejects a record without rootKeyId whose signature does not match the current binding", async () => {
    const oldKey = await generateDID()
    const newKey = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair: oldKey },
      "Age verification",
      context,
    )
    const resolveRootKey = memoryResolver({
      [PLC_DID]: [await bindingFor(newKey.publicKey, CURRENT_CID)],
    })
    expect(
      await verifyAuthorizationRecord(authorization, {
        resolveRootKey,
        allowHistoricalKeys: true,
      }),
    ).toBe(false)
  })

  it("refuses to issue a did:key record under a DID that is not the keypair's", async () => {
    const a = await generateDID()
    const b = await generateDID()
    await expect(
      generateAuthorizedEphemeralDID(
        { did: a.did, keyPair: b },
        "Age verification",
        context,
      ),
    ).rejects.toThrow(/its own keypair/)
  })

  it("refuses to issue a did:key record that names a binding", async () => {
    const keyPair = await generateDID()
    await expect(
      generateAuthorizedEphemeralDID(
        { did: keyPair.did, keyPair, rootKeyId: CURRENT_CID },
        "Age verification",
        context,
      ),
    ).rejects.toThrow(/external root/)
  })

  it("verifies a did:key root without consulting any resolver", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      keyPair,
      "Age verification",
      context,
    )
    expect(authorization.rootKeyId).toBeUndefined()
    const resolveRootKey = vi.fn<RootKeyResolver>(async () => null)
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(true)
    expect(resolveRootKey).not.toHaveBeenCalled()
  })

  it("reports a root DID it cannot parse as invalid rather than throwing", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: "did:web:%", keyPair },
      "Age verification",
      context,
    )
    const resolveRootKey = createRootKeyResolver({
      resolveDid: httpDidResolver({
        fetch: async () => {
          throw new Error("must not be reached")
        },
      }),
    })
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(false)
  })

  it("lets a resolver failure propagate rather than reporting the record invalid", async () => {
    const keyPair = await generateDID()
    const { authorization } = await generateAuthorizedEphemeralDID(
      { did: PLC_DID, keyPair },
      "Age verification",
      context,
    )
    const resolveRootKey: RootKeyResolver = async () => {
      throw new Error("directory unreachable")
    }
    await expect(
      verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).rejects.toThrow("directory unreachable")
  })
})

describe("root key records", () => {
  it("round-trips a key through the record form", async () => {
    const keyPair = await generateDID()
    const record = rootKeyRecord(
      keyPair.publicKey,
      "2026-01-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    )
    expect(record.$type).toBe(ROOT_KEY_COLLECTION)
    expect(record.publicKeyMultibase).toMatch(/^z6Mk/)
    const binding = parseRootKeyRecord("bafycid", record)
    expect(binding).not.toBeNull()
    expect(binding?.publicKey).toEqual(keyPair.publicKey)
    expect(binding?.expiresAt).toBe("2027-01-01T00:00:00.000Z")
  })

  it("refuses to build a record with a timestamp that does not parse", async () => {
    const keyPair = await generateDID()
    expect(() => rootKeyRecord(keyPair.publicKey, "today")).toThrow(RangeError)
    expect(() =>
      rootKeyRecord(keyPair.publicKey, "2026-01-01T00:00:00.000Z", "never"),
    ).toThrow(RangeError)
  })

  it("treats a record that is not a well-formed binding as no binding", () => {
    expect(parseRootKeyRecord("c", null)).toBeNull()
    expect(
      parseRootKeyRecord("c", { $type: "app.bsky.actor.profile" }),
    ).toBeNull()
    expect(
      parseRootKeyRecord("c", {
        $type: ROOT_KEY_COLLECTION,
        publicKeyMultibase: "zNotAKey",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBeNull()
    expect(
      parseRootKeyRecord("c", {
        $type: ROOT_KEY_COLLECTION,
        publicKeyMultibase: "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      }),
    ).toBeNull()
  })

  it("judges validity at a point in time", () => {
    const binding: RootKeyBinding = {
      cid: "c",
      publicKey: new Uint8Array(32),
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-06-01T00:00:00.000Z",
    }
    expect(isBindingValidAt(binding, new Date("2025-12-31T00:00:00Z"))).toBe(
      false,
    )
    expect(isBindingValidAt(binding, new Date("2026-03-01T00:00:00Z"))).toBe(
      true,
    )
    expect(isBindingValidAt(binding, new Date("2026-06-01T00:00:00Z"))).toBe(
      false,
    )
    expect(
      isBindingValidAt({ ...binding, createdAt: "never" }, new Date()),
    ).toBe(false)
    const superseded = {
      ...binding,
      expiresAt: undefined,
      supersededAt: "2026-04-01T00:00:00.000Z",
    }
    expect(isBindingValidAt(superseded, new Date("2026-03-31T00:00:00Z"))).toBe(
      true,
    )
    expect(isBindingValidAt(superseded, new Date("2026-04-01T00:00:00Z"))).toBe(
      false,
    )
    const skewed = { ...binding, createdAt: "2026-01-01T00:01:00.000Z" }
    expect(isBindingValidAt(skewed, new Date("2026-01-01T00:00:00Z"))).toBe(
      false,
    )
    expect(
      isBindingValidAt(skewed, new Date("2026-01-01T00:00:00Z"), 120_000),
    ).toBe(true)
  })
})

describe("resolution over HTTP", () => {
  const pds = "https://pds.example"
  const document = {
    id: PLC_DID,
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: `${pds}/`,
      },
    ],
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }

  it("locates DID documents", () => {
    expect(didDocumentUrl(PLC_DID)).toBe(`https://plc.directory/${PLC_DID}`)
    expect(
      didDocumentUrl(PLC_DID, { plcDirectory: "https://plc.example/" }),
    ).toBe(`https://plc.example/${PLC_DID}`)
    expect(didDocumentUrl("did:web:alice.example")).toBe(
      "https://alice.example/.well-known/did.json",
    )
    expect(didDocumentUrl("did:web:alice.example:path")).toBeNull()
    expect(didDocumentUrl("did:web:alice.example:8443")).toBeNull()
    expect(didDocumentUrl("did:web:alice.example%2Fpath")).toBeNull()
    expect(didDocumentUrl("did:plc:not-a-plc-id")).toBeNull()
    expect(didDocumentUrl("did:key:z6Mk")).toBeNull()
  })

  it("keeps did:web off local hosts and ports unless allowed for development", () => {
    expect(didDocumentUrl("did:web:localhost%3A3000")).toBeNull()
    expect(didDocumentUrl("did:web:localhost")).toBeNull()
    expect(didDocumentUrl("did:web:pds.localhost")).toBeNull()
    expect(didDocumentUrl("did:web:10.0.0.1")).toBeNull()
    expect(didDocumentUrl("did:web:127.1")).toBeNull()
    expect(didDocumentUrl("did:web:0x7f000001")).toBeNull()
    expect(didDocumentUrl("did:web:2130706433")).toBeNull()
    expect(didDocumentUrl("did:web:%")).toBeNull()
    expect(didDocumentUrl("did:web:alice.example%3A8443")).toBeNull()
    expect(
      didDocumentUrl("did:web:alice.example:8443", { allowLocal: true }),
    ).toBeNull()
    expect(
      didDocumentUrl("did:web:localhost%3A3000", { allowLocal: true }),
    ).toBe("https://localhost:3000/.well-known/did.json")
    expect(
      didDocumentUrl("did:web:alice.example%3A8443", { allowLocal: true }),
    ).toBe("https://alice.example:8443/.well-known/did.json")
  })

  it("reads the PDS from the document's service entry", () => {
    expect(pdsEndpoint(document, PLC_DID)).toBe(pds)
    expect(
      pdsEndpoint(
        {
          id: PLC_DID,
          service: [
            {
              id: `${PLC_DID}#atproto_pds`,
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: pds,
            },
          ],
        },
        PLC_DID,
      ),
    ).toBe(pds)
    expect(
      pdsEndpoint(
        {
          id: PLC_DID,
          service: [{ id: "#other", type: "X", serviceEndpoint: pds }],
        },
        PLC_DID,
      ),
    ).toBeNull()
    expect(pdsEndpoint({ id: PLC_DID }, PLC_DID)).toBeNull()
  })

  it("refuses a body over the size limit, cancelling the stream", async () => {
    let pulls = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(16_384))
      },
      cancel() {
        cancelled = true
      },
    })
    const huge = httpDidResolver({
      fetch: async () => new Response(endless, { status: 200 }),
    })
    await expect(huge(PLC_DID)).rejects.toThrow(/byte limit/)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
    const declared = httpDidResolver({
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": "99999999" },
        }),
    })
    await expect(declared(PLC_DID)).rejects.toThrow(/byte limit/)
  })

  it("treats a body that is not a DID document as unresolved", async () => {
    const resolve = httpDidResolver({
      fetch: async () => jsonResponse(200, "not a document"),
    })
    expect(await resolve(PLC_DID)).toBeNull()
    const oddService = httpDidResolver({
      fetch: async () => jsonResponse(200, { id: PLC_DID, service: "pds" }),
    })
    expect(await oddService(PLC_DID)).toBeNull()
  })

  it("matches the service entry by its exact id, not a suffix", () => {
    const other = {
      id: PLC_DID,
      service: [
        {
          id: "did:plc:someoneelse2345abcdefghi#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: "https://evil.example",
        },
        {
          id: `${PLC_DID}#atproto_pds`,
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: pds,
        },
      ],
    }
    expect(pdsEndpoint(other, PLC_DID)).toBe(pds)
  })

  it("rejects a document for another DID", () => {
    expect(pdsEndpoint(document, WEB_DID)).toBeNull()
    expect(pdsEndpoint({ ...document, id: undefined }, PLC_DID)).toBeNull()
  })

  it("accepts only an https origin as a PDS, or a local http one for development", () => {
    const withEndpoint = (serviceEndpoint: string) => ({
      id: PLC_DID,
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint,
        },
      ],
    })
    expect(pdsEndpoint(withEndpoint("http://pds.example"), PLC_DID)).toBeNull()
    expect(
      pdsEndpoint(withEndpoint("https://pds.example/xrpc"), PLC_DID),
    ).toBeNull()
    expect(
      pdsEndpoint(withEndpoint("https://pds.example/?x=1"), PLC_DID),
    ).toBeNull()
    expect(pdsEndpoint(withEndpoint("not a url"), PLC_DID)).toBeNull()
    expect(
      pdsEndpoint(withEndpoint("https://user:pw@pds.example"), PLC_DID),
    ).toBeNull()
    expect(
      pdsEndpoint(withEndpoint("https://localhost:2583"), PLC_DID),
    ).toBeNull()
    expect(pdsEndpoint(withEndpoint("https://127.0.0.1"), PLC_DID)).toBeNull()
    expect(pdsEndpoint(withEndpoint("https://[::1]"), PLC_DID)).toBeNull()
    expect(
      pdsEndpoint(withEndpoint("https://169.254.169.254/"), PLC_DID),
    ).toBeNull()
    expect(pdsEndpoint(withEndpoint("https://127.1"), PLC_DID)).toBeNull()
    expect(pdsEndpoint(withEndpoint("https://0x7f000001"), PLC_DID)).toBeNull()
    expect(pdsEndpoint(withEndpoint("https://localhost."), PLC_DID)).toBeNull()
    expect(
      pdsEndpoint(withEndpoint("http://localhost:2583/"), PLC_DID, {
        allowLocal: true,
      }),
    ).toBe("http://localhost:2583")
    expect(
      pdsEndpoint(withEndpoint("http://pds.example"), PLC_DID, {
        allowLocal: true,
      }),
    ).toBeNull()
  })

  it("resolves a did:plc through the directory", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`https://plc.directory/${PLC_DID}`)
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.redirect).toBe("error")
      return jsonResponse(200, document)
    })
    const resolve = httpDidResolver({
      fetch: fetchMock,
    })
    expect(await resolve(PLC_DID)).toEqual(document)
  })

  it("reports an unknown DID as unresolved and any other failure as an error", async () => {
    const notFound = httpDidResolver({
      fetch: async () => jsonResponse(404, {}),
    })
    expect(await notFound(PLC_DID)).toBeNull()
    const tombstoned = httpDidResolver({
      fetch: async () => jsonResponse(410, {}),
    })
    expect(await tombstoned(PLC_DID)).toBeNull()
    const catchAllPage = httpDidResolver({
      fetch: async () => new Response("<!doctype html>", { status: 200 }),
    })
    expect(await catchAllPage(WEB_DID)).toBeNull()
    const empty = httpDidResolver({
      fetch: async () => new Response(null, { status: 200 }),
    })
    expect(await empty(WEB_DID)).toBeNull()
    const broken = httpDidResolver({
      fetch: async () => jsonResponse(503, {}),
    })
    await expect(broken(PLC_DID)).rejects.toThrow(/HTTP 503/)
  })

  it("fetches the binding record from the PDS, by CID when asked", async () => {
    const keyPair = await generateDID()
    const record = rootKeyRecord(keyPair.publicKey, "2026-01-01T00:00:00.000Z")
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url)
      const parsed = new URL(url)
      if (parsed.pathname.endsWith("/xrpc/com.atproto.repo.getRecord")) {
        const cid = parsed.searchParams.get("cid") ?? CURRENT_CID
        if (cid === OLD_CID) {
          return jsonResponse(400, { error: "RecordNotFound", message: "gone" })
        }
        return jsonResponse(200, {
          uri: `at://${PLC_DID}/${ROOT_KEY_COLLECTION}/self`,
          cid,
          value: record,
        })
      }
      return jsonResponse(200, document)
    })
    const resolve = createRootKeyResolver({
      fetch: fetchMock,
    })

    const current = await resolve(PLC_DID)
    expect(current?.cid).toBe(CURRENT_CID)
    expect(current?.publicKey).toEqual(keyPair.publicKey)
    expect(seen[1]).toBe(
      `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(PLC_DID)}&collection=${ROOT_KEY_COLLECTION}&rkey=self`,
    )

    expect(await resolve(PLC_DID, OLD_CID)).toBeNull()
    expect(seen[3]).toContain(`&cid=${OLD_CID}`)
  })

  it("returns no binding for a DID that is not an external root", async () => {
    const resolve = createRootKeyResolver({
      resolveDid: async () => document,
      fetchRecord: async () => ({ cid: "c", value: {} }),
    })
    expect(await resolve("did:key:z6Mk")).toBeNull()
  })

  it("treats a missing PDS, a missing record and a wrong CID as no binding", async () => {
    const keyPair = await generateDID()
    const record = rootKeyRecord(keyPair.publicKey, "2026-01-01T00:00:00.000Z")
    const noPds = createRootKeyResolver({
      resolveDid: async () => ({ id: PLC_DID }),
      fetchRecord: async () => ({ cid: CURRENT_CID, value: record }),
    })
    expect(await noPds(PLC_DID)).toBeNull()

    const noRecord = createRootKeyResolver({
      resolveDid: async () => document,
      fetchRecord: async () => null,
    })
    expect(await noRecord(PLC_DID)).toBeNull()

    const wrongCid = createRootKeyResolver({
      resolveDid: async () => document,
      fetchRecord: async () => ({ cid: CURRENT_CID, value: record }),
    })
    expect(await wrongCid(PLC_DID, OLD_CID)).toBeNull()
    expect((await wrongCid(PLC_DID))?.cid).toBe(CURRENT_CID)
  })

  it("treats a gone repository like a missing record", async () => {
    const fetcher = xrpcRecordFetcher({
      fetch: async () =>
        jsonResponse(400, { error: "RepoTakendown", message: "gone" }),
    })
    expect(
      await fetcher({
        pds,
        repo: PLC_DID,
        collection: ROOT_KEY_COLLECTION,
        rkey: "self",
      }),
    ).toBeNull()
    const other = xrpcRecordFetcher({
      fetch: async () =>
        jsonResponse(400, { error: "InvalidRequest", message: "bad" }),
    })
    await expect(
      other({
        pds,
        repo: PLC_DID,
        collection: ROOT_KEY_COLLECTION,
        rkey: "self",
      }),
    ).rejects.toThrow(/HTTP 400 \(InvalidRequest\)/)
  })

  it("treats a JSON null reply as a record without a CID", async () => {
    const fetcher = xrpcRecordFetcher({
      fetch: async () => jsonResponse(200, null),
    })
    await expect(
      fetcher({
        pds,
        repo: PLC_DID,
        collection: ROOT_KEY_COLLECTION,
        rkey: "self",
      }),
    ).rejects.toThrow(/without a CID/)
  })

  it("surfaces a record endpoint failure", async () => {
    const fetcher = xrpcRecordFetcher({
      fetch: async () =>
        jsonResponse(500, {
          error: "InternalServerError",
        }),
    })
    await expect(
      fetcher({
        pds,
        repo: PLC_DID,
        collection: ROOT_KEY_COLLECTION,
        rkey: "self",
      }),
    ).rejects.toThrow(/HTTP 500/)
  })
})
