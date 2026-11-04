import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  generateAuthorizedEphemeralDID,
  generateDID,
  publicKeyToDID,
  verifyAuthorizationRecord,
} from "../src/did.js"
import {
  type AtprotoSession,
  parseRootKeyRecord,
  publishRootKeyBinding,
  ROOT_KEY_COLLECTION,
  type RootKeyResolver,
  revokeRootKeyBinding,
  rootKeyRecord,
} from "../src/root.js"

const DID = "did:plc:exampleroot2345abcdefghi"
const CID = "bafyreipublishedcid"

/** A session that records the writes it is asked to make. */
function fakeSession(
  reply: (pathname: string, body: Record<string, unknown>) => Response,
): AtprotoSession & { calls: Array<{ pathname: string; init?: RequestInit }> } {
  const calls: Array<{ pathname: string; init?: RequestInit }> = []
  return {
    did: DID,
    calls,
    async fetchHandler(pathname, init) {
      calls.push({ pathname, init })
      return reply(pathname, JSON.parse(String(init?.body ?? "{}")))
    },
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe("publishRootKeyBinding", () => {
  it("writes the singleton record through the session and names it in the identity", async () => {
    const keyPair = await generateDID()
    const session = fakeSession((_pathname, body) =>
      json(200, {
        uri: `at://${body.repo}/${body.collection}/${body.rkey}`,
        cid: CID,
      }),
    )

    const published = await publishRootKeyBinding(session, keyPair, {
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    })

    expect(session.calls).toHaveLength(1)
    const { pathname, init } = session.calls[0]
    expect(pathname).toBe("/xrpc/com.atproto.repo.putRecord")
    expect(init?.method).toBe("POST")
    const body = JSON.parse(String(init?.body))
    expect(body.repo).toBe(DID)
    expect(body.collection).toBe(ROOT_KEY_COLLECTION)
    expect(body.rkey).toBe("self")
    expect(body.record).toEqual(
      rootKeyRecord(
        keyPair.publicKey,
        "2026-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
      ),
    )

    expect(published.cid).toBe(CID)
    expect(published.uri).toBe(`at://${DID}/${ROOT_KEY_COLLECTION}/self`)
    expect(published.identity).toEqual({ did: DID, keyPair, rootKeyId: CID })
  })

  it("yields an identity whose records verify against what was published", async () => {
    const keyPair = await generateDID()
    let stored: unknown
    const session = fakeSession((_pathname, body) => {
      stored = body.record
      return json(200, { uri: "at://x", cid: CID })
    })
    const { identity } = await publishRootKeyBinding(session, keyPair)
    expect(stored).toEqual(
      expect.objectContaining({
        publicKeyMultibase: publicKeyToDID(keyPair.publicKey).slice(
          "did:key:".length,
        ),
      }),
    )

    const { authorization } = await generateAuthorizedEphemeralDID(
      identity,
      "Age verification",
      { verificationType: "age_over_18" },
    )
    const resolveRootKey: RootKeyResolver = async () =>
      parseRootKeyRecord(CID, stored)
    expect(
      await verifyAuthorizationRecord(authorization, { resolveRootKey }),
    ).toBe(true)
  })

  it("reports a refused write and a reply without an address", async () => {
    const keyPair = await generateDID()
    const refused = fakeSession(() =>
      json(403, { error: "InvalidToken", message: "scope" }),
    )
    await expect(publishRootKeyBinding(refused, keyPair)).rejects.toThrow(
      /HTTP 403 \(InvalidToken\)/,
    )
    const silent = fakeSession(() => json(200, {}))
    await expect(publishRootKeyBinding(silent, keyPair)).rejects.toThrow(
      /no record address/,
    )
    const nothing = fakeSession(() => json(200, null))
    await expect(publishRootKeyBinding(nothing, keyPair)).rejects.toThrow(
      /no record address/,
    )
  })
})

describe("revokeRootKeyBinding", () => {
  it("deletes the singleton record", async () => {
    const session = fakeSession(() => json(200, {}))
    await revokeRootKeyBinding(session)
    const { pathname, init } = session.calls[0]
    expect(pathname).toBe("/xrpc/com.atproto.repo.deleteRecord")
    expect(JSON.parse(String(init?.body))).toEqual({
      repo: DID,
      collection: ROOT_KEY_COLLECTION,
      rkey: "self",
    })
  })

  it("reports a refused delete", async () => {
    const session = fakeSession(() => json(401, {}))
    await expect(revokeRootKeyBinding(session)).rejects.toThrow(/HTTP 401/)
  })
})

describe("the earth.freehold.rootKey lexicon", () => {
  const lexicon = JSON.parse(
    readFileSync(
      new URL(
        "../../spec/schemas/lexicons/earth.freehold.rootKey.json",
        import.meta.url,
      ),
      "utf8",
    ),
  )

  it("describes the record the package writes", async () => {
    expect(lexicon.id).toBe(ROOT_KEY_COLLECTION)
    const main = lexicon.defs.main
    expect(main.type).toBe("record")
    expect(main.key).toBe("literal:self")

    const keyPair = await generateDID()
    const record = rootKeyRecord(
      keyPair.publicKey,
      "2026-01-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    )
    const { $type, ...fields } = record
    expect($type).toBe(lexicon.id)
    expect(Object.keys(fields).sort()).toEqual(
      Object.keys(main.record.properties).sort(),
    )
    for (const name of main.record.required) {
      expect(fields).toHaveProperty(name)
    }
    const key = main.record.properties.publicKeyMultibase
    expect(record.publicKeyMultibase.length).toBeGreaterThanOrEqual(
      key.minLength,
    )
    expect(record.publicKeyMultibase.length).toBeLessThanOrEqual(key.maxLength)
  })
})
