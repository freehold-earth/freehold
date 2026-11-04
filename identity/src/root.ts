/**
 * Root identities whose identifier is not itself a key.
 *
 * A did:key root is verified from its identifier. A root such as did:plc or
 * did:web names an atproto account, whose holder normally holds no signing
 * key of their own, so the Freehold signing key is published as a record in
 * the account's repository under the `earth.freehold.rootKey` lexicon. The
 * record is committed by the PDS on the holder's behalf, so its presence in
 * the signed repository is the holder's authorisation of that key. Deleting
 * or replacing the record revokes the binding.
 *
 * Resolution is injectable: a verifier can supply its own DID resolver and
 * record fetcher, or a whole root key resolver, so tests and offline use
 * never touch the network.
 *
 * A verifier trusts the PDS the DID document names to serve the account's
 * record as committed. Checking the repository's commit proof against the
 * account's atproto signing key is not done here.
 */

import type { DIDKeyPair } from "./did.js"
import { didToPublicKey, publicKeyToDID } from "./key.js"

/** The lexicon the binding record is stored under. */
export const ROOT_KEY_COLLECTION = "earth.freehold.rootKey"

/** The binding is a singleton record, so its key is fixed. */
export const ROOT_KEY_RECORD_KEY = "self"

/** Where did:plc identifiers resolve by default. */
export const DEFAULT_PLC_DIRECTORY = "https://plc.directory"

/** A root identity: the DID records name as their root, and the key that signs for it. */
export interface RootIdentity {
  /** did:key, did:plc or did:web */
  did: string
  /** The Ed25519 keypair that signs authorization records */
  keyPair: DIDKeyPair
  /**
   * CID of the published binding record, for a root that is not a did:key.
   * Issued records carry it so they stay checkable after the binding changes.
   */
  rootKeyId?: string
}

/** The published binding of a root DID to its Freehold signing key, as resolved. */
export interface RootKeyBinding {
  /** CID of the record as stored */
  cid: string
  /** Raw 32-byte Ed25519 public key */
  publicKey: Uint8Array
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601; the binding is not to be used after this */
  expiresAt?: string
  /**
   * ISO 8601; when the binding stopped being the account's current one,
   * because it was replaced or deleted. A PDS never reports this, so it is
   * set by a resolver that keeps past bindings itself, and it closes the
   * window a historical verification accepts.
   */
  supersededAt?: string
}

/**
 * How far a binding's `createdAt` may sit ahead of the verifier's clock, or a
 * record's timestamp ahead of it, before the two are taken to disagree
 * rather than to be skewed.
 */
export const CLOCK_TOLERANCE_MS = 300_000

/** The stored form of the binding record: the lexicon's record object. */
export interface RootKeyRecord {
  $type: typeof ROOT_KEY_COLLECTION
  /** Multibase (base58btc, `z`) multicodec Ed25519 public key, as in a did:key */
  publicKeyMultibase: string
  createdAt: string
  expiresAt?: string
}

/** The parts of a DID document resolution reads. */
export interface DIDDocument {
  id?: string
  service?: Array<{ id: string; type: string; serviceEndpoint: unknown }>
}

/** What a DID document fetch or a record fetch is made with: `fetch`, or a stand-in. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Resolve a DID to its document, or null when it does not resolve. */
export type DIDResolver = (did: string) => Promise<DIDDocument | null>

/**
 * Fetch one record from a repository: the current one, or the version with
 * the given CID. Null when the record does not exist.
 */
export type RecordFetcher = (query: {
  pds: string
  repo: string
  collection: string
  rkey: string
  cid?: string
}) => Promise<{ cid: string; value: unknown } | null>

/**
 * Resolve a root DID to its signing key binding: the current one, or the one
 * with the given CID. Null when the root has no usable binding.
 */
export type RootKeyResolver = (
  did: string,
  rootKeyId?: string,
) => Promise<RootKeyBinding | null>

/** What the default root key resolver is built from; every part is replaceable. */
export interface RootKeyResolverOptions {
  fetch?: FetchLike
  resolveDid?: DIDResolver
  fetchRecord?: RecordFetcher
  plcDirectory?: string
  /**
   * Accept localhost, IP-literal and plain-http destinations, for development
   * against a local PDS. Off by default: a DID document is data the account
   * controls, so the hosts it names are never allowed to reach into the
   * verifier's own network.
   */
  allowLocal?: boolean
  /** How long one HTTP request may take; 10 seconds by default. */
  timeoutMs?: number
}

/** How did:web hosts and PDS endpoints are judged. */
export type DestinationOptions = Pick<
  RootKeyResolverOptions,
  "plcDirectory" | "allowLocal"
>

const DEFAULT_TIMEOUT_MS = 10_000

/** Largest DID document or record body resolution will read. */
const MAX_BODY_BYTES = 65_536

/**
 * localhost, a `.localhost` name, or an IP literal, judged on the hostname
 * as the URL parser canonicalises it, so `127.1` and `0x7f000001` are seen
 * for what they are. Private DNS names cannot be told apart here.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.startsWith("[") ||
    host.includes(":")
  )
}

/** The hostname the URL parser would connect to for `host`, or null when it cannot parse it. */
function canonicalHostname(host: string): string | null {
  try {
    return new URL(`https://${host}`).hostname
  } catch {
    return null
  }
}

/**
 * The body of a response, read no further than the size resolution accepts:
 * the reader is cancelled the moment the running total passes the limit, so
 * a host cannot make the verifier buffer an unbounded reply. A declared
 * length over the limit is refused before any byte is read.
 */
async function boundedText(response: Response, what: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await discard(response)
    throw new Error(
      `${what} is ${declared} bytes, over the ${MAX_BODY_BYTES}-byte limit`,
    )
  }
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new Error(`${what} is over the ${MAX_BODY_BYTES}-byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** The parsed JSON body of a response, read within the size limit. */
async function boundedJson(response: Response, what: string): Promise<unknown> {
  return JSON.parse(await boundedText(response, what))
}

/** Release a response whose body will not be read. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * The error code an XRPC reply carries, read within the size limit; undefined
 * when the body is not JSON or names none. The body is consumed either way.
 */
async function xrpcErrorCode(response: Response): Promise<string | undefined> {
  let body: unknown
  try {
    body = await boundedJson(response, "the error reply")
  } catch (err) {
    if (err instanceof SyntaxError) return undefined
    throw err
  }
  if (body === null || typeof body !== "object") return undefined
  const { error } = body as { error?: unknown }
  return typeof error === "string" ? error : undefined
}

/** `HTTP 403 (InvalidToken)`, or `HTTP 403` when the reply named no code. */
function httpFailure(status: number, code: string | undefined): string {
  return `HTTP ${status}${code === undefined ? "" : ` (${code})`}`
}

/** Whether a DID is one that resolves through a published binding rather than its identifier. */
export function isExternalRootDid(did: string): boolean {
  return did.startsWith("did:plc:") || did.startsWith("did:web:")
}

/**
 * The record object that publishes `publicKey` as a root's signing key.
 *
 * @throws RangeError when a timestamp does not parse, since the record would
 *   be committed to the repository and then never verify
 */
export function rootKeyRecord(
  publicKey: Uint8Array,
  createdAt: string,
  expiresAt?: string,
): RootKeyRecord {
  for (const [name, value] of [
    ["createdAt", createdAt],
    ["expiresAt", expiresAt],
  ] as const) {
    if (value !== undefined && Number.isNaN(new Date(value).getTime())) {
      throw new RangeError(`${name} is not a timestamp: ${value}`)
    }
  }
  const record: RootKeyRecord = {
    $type: ROOT_KEY_COLLECTION,
    publicKeyMultibase: publicKeyToDID(publicKey).slice("did:key:".length),
    createdAt,
  }
  if (expiresAt !== undefined) record.expiresAt = expiresAt
  return record
}

/**
 * Read a binding out of a stored record, or null when the record is not a
 * well-formed binding. The key is checked the way a did:key is.
 */
export function parseRootKeyRecord(
  cid: string,
  value: unknown,
): RootKeyBinding | null {
  if (value === null || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (record.$type !== ROOT_KEY_COLLECTION) return null
  if (typeof record.publicKeyMultibase !== "string") return null
  if (typeof record.createdAt !== "string") return null
  if (record.expiresAt !== undefined && typeof record.expiresAt !== "string") {
    return null
  }
  if (record.publicKeyMultibase.length > 64) return null
  const publicKey = didToPublicKey(`did:key:${record.publicKeyMultibase}`)
  if (publicKey === null || publicKey.length !== 32) return null
  const binding: RootKeyBinding = {
    cid,
    publicKey,
    createdAt: record.createdAt,
  }
  if (record.expiresAt !== undefined) binding.expiresAt = record.expiresAt
  return binding
}

/**
 * Whether a binding may be relied on at `at`: created by then (allowing
 * `toleranceMs` of clock skew), and neither expired nor superseded by then.
 * An unparseable timestamp is not "never", it is invalid.
 */
export function isBindingValidAt(
  binding: RootKeyBinding,
  at: Date,
  toleranceMs = 0,
): boolean {
  const createdAt = new Date(binding.createdAt)
  if (Number.isNaN(createdAt.getTime())) return false
  if (createdAt.getTime() > at.getTime() + toleranceMs) return false
  for (const end of [binding.expiresAt, binding.supersededAt]) {
    if (end === undefined) continue
    const endsAt = new Date(end)
    if (Number.isNaN(endsAt.getTime()) || at >= endsAt) return false
  }
  return true
}

/**
 * The URL a DID document is fetched from: the PLC directory for did:plc, the
 * well-known location for a did:web hostname. atproto allows only hostname
 * did:web identifiers, so a path (anything after a bare colon) is rejected,
 * and a port (`%3A`-encoded) or a local host only with `allowLocal`.
 */
export function didDocumentUrl(
  did: string,
  options: DestinationOptions = {},
): string | null {
  const plcDirectory = options.plcDirectory ?? DEFAULT_PLC_DIRECTORY
  if (did.startsWith("did:plc:")) {
    const id = did.slice("did:plc:".length)
    if (!/^[a-z2-7]{24}$/.test(id)) return null
    return `${plcDirectory.replace(/\/$/, "")}/${did}`
  }
  if (did.startsWith("did:web:")) {
    const id = did.slice("did:web:".length)
    // A bare colon is the method's path separator; a port is percent-encoded
    if (id.includes(":")) return null
    let host: string
    try {
      host = decodeURIComponent(id)
    } catch {
      return null
    }
    const match =
      /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i.exec(
        host,
      )
    if (match === null) return null
    const hostname = canonicalHostname(host)
    if (hostname === null) return null
    const local = isLocalHost(hostname) || match[2] !== undefined
    if (local && options.allowLocal !== true) return null
    return `https://${host}/.well-known/did.json`
  }
  return null
}

/**
 * Read a DID document out of a response body, or null when the body is not
 * one. Only the parts resolution reads are checked.
 */
export function parseDidDocument(value: unknown): DIDDocument | null {
  if (value === null || typeof value !== "object") return null
  const document = value as Record<string, unknown>
  if (document.id !== undefined && typeof document.id !== "string") return null
  if (document.service !== undefined && !Array.isArray(document.service)) {
    return null
  }
  return document as DIDDocument
}

/**
 * The PDS a DID document names for `did`, or null when the document is not
 * that DID's or names no acceptable PDS: an https origin, with no path, on a
 * host that is not local unless `allowLocal` says so.
 */
export function pdsEndpoint(
  document: DIDDocument,
  did: string,
  options: DestinationOptions = {},
): string | null {
  if (document.id !== did) return null
  if (!Array.isArray(document.service)) return null
  const service = document.service.find(
    (entry) =>
      typeof entry?.id === "string" &&
      (entry.id === "#atproto_pds" || entry.id === `${did}#atproto_pds`) &&
      entry.type === "AtprotoPersonalDataServer",
  )
  if (service === undefined || typeof service.serviceEndpoint !== "string") {
    return null
  }
  let url: URL
  try {
    url = new URL(service.serviceEndpoint)
  } catch {
    return null
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return null
  }
  if (url.username !== "" || url.password !== "") return null
  const local = isLocalHost(url.hostname)
  if (local && options.allowLocal !== true) return null
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return null
  }
  return url.origin
}

/** A DID resolver over HTTP: plc.directory for did:plc, the well-known document for did:web. */
export function httpDidResolver(
  options: Pick<
    RootKeyResolverOptions,
    "fetch" | "plcDirectory" | "allowLocal" | "timeoutMs"
  > = {},
): DIDResolver {
  const doFetch = options.fetch ?? fetch
  return async (did) => {
    const url = didDocumentUrl(did, options)
    if (url === null) return null
    // The host was judged before the request; a redirect would move it
    const response = await doFetch(url, {
      headers: { accept: "application/did+ld+json, application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    // 404: no such DID; 410: a did:plc that has been tombstoned
    if (response.status === 404 || response.status === 410) {
      await discard(response)
      return null
    }
    if (!response.ok) {
      await discard(response)
      throw new Error(`resolving ${did} failed with HTTP ${response.status}`)
    }
    let body: unknown
    try {
      body = await boundedJson(response, `the DID document of ${did}`)
    } catch (err) {
      // A host answering 200 with something other than JSON (a site's
      // catch-all page, an empty body) has no DID document there
      if (err instanceof SyntaxError) return null
      throw err
    }
    return parseDidDocument(body)
  }
}

/**
 * getRecord errors that mean the record is definitively not there: the
 * record itself, or the whole repository, is gone. Anything else is a
 * failure to find out.
 */
const NO_RECORD_ERRORS = new Set([
  "RecordNotFound",
  "RepoNotFound",
  "RepoDeactivated",
  "RepoSuspended",
  "RepoTakendown",
])

/** A record fetcher over the public, unauthenticated getRecord endpoint of a PDS. */
export function xrpcRecordFetcher(
  options: Pick<RootKeyResolverOptions, "fetch" | "timeoutMs"> = {},
): RecordFetcher {
  const doFetch = options.fetch ?? fetch
  return async ({ pds, repo, collection, rkey, cid }) => {
    const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`)
    url.searchParams.set("repo", repo)
    url.searchParams.set("collection", collection)
    url.searchParams.set("rkey", rkey)
    if (cid !== undefined) url.searchParams.set("cid", cid)
    const response = await doFetch(url.toString(), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (response.ok) {
      const body = (await boundedJson(
        response,
        `record ${collection}/${rkey} of ${repo}`,
      )) as { cid?: unknown; value?: unknown } | null
      if (
        body === null ||
        typeof body !== "object" ||
        typeof body.cid !== "string"
      ) {
        throw new Error(
          `record ${collection}/${rkey} of ${repo} came back without a CID`,
        )
      }
      return { cid: body.cid, value: body.value }
    }
    let code: string | undefined
    if (response.status === 400 || response.status === 404) {
      code = await xrpcErrorCode(response)
      if (code !== undefined && NO_RECORD_ERRORS.has(code)) return null
    } else {
      await discard(response)
    }
    throw new Error(
      `fetching ${collection}/${rkey} of ${repo} failed with ${httpFailure(response.status, code)}`,
    )
  }
}

/**
 * Build a root key resolver: DID document, then PDS, then the binding record.
 *
 * With a `rootKeyId` the record version with that CID is requested, which is
 * how a record issued under an earlier binding is checked; a PDS that no
 * longer holds that version answers as if the record did not exist.
 */
export function createRootKeyResolver(
  options: RootKeyResolverOptions = {},
): RootKeyResolver {
  const resolveDid = options.resolveDid ?? httpDidResolver(options)
  const fetchRecord = options.fetchRecord ?? xrpcRecordFetcher(options)
  return async (did, rootKeyId) => {
    if (!isExternalRootDid(did)) return null
    const document = await resolveDid(did)
    if (document === null) return null
    const pds = pdsEndpoint(document, did, options)
    if (pds === null) return null
    const query = {
      pds,
      repo: did,
      collection: ROOT_KEY_COLLECTION,
      rkey: ROOT_KEY_RECORD_KEY,
      ...(rootKeyId === undefined ? {} : { cid: rootKeyId }),
    }
    const record = await fetchRecord(query)
    if (record === null) return null
    if (rootKeyId !== undefined && record.cid !== rootKeyId) return null
    return parseRootKeyRecord(record.cid, record.value)
  }
}

/** The default resolver: plc.directory, well-known did:web documents, public PDS reads. */
export const resolveRootKey: RootKeyResolver = createRootKeyResolver()
