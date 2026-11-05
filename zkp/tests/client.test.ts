import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above every other statement, so what its factories
// reference must be hoisted with it.
const { provider, ledger } = vi.hoisted(() => ({
  provider: { queryContractState: vi.fn() },
  ledger: vi.fn(),
}));
vi.mock("@midnight-ntwrk/midnight-js-indexer-public-data-provider", () => ({
  indexerPublicDataProvider: () => provider,
}));
vi.mock("../sdk/src/midnight/contract-module.js", () => ({
  loadContractModule: async () => ({ ledger }),
  resolveContractAssetsPath: (p?: string) => {
    if (p === "/missing") throw new Error("Contract assets not found at: /missing");
    return p ?? "/managed";
  },
}));

import { buildIndexerUrls, getClientState, initializeClient, queryContractState, queryTransaction } from "../sdk/src/midnight/client.js";

const COMMITMENT = Uint8Array.from({ length: 32 }, (_, i) => i);

describe("queryContractState", () => {
  beforeEach(() => {
    provider.queryContractState.mockReset();
    ledger.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("decodes the indexer's state with the compiled contract and names the circuit's fields", async () => {
    const state = { data: Symbol("charged state") };
    provider.queryContractState.mockResolvedValue(state);
    ledger.mockReturnValue({ verified: true, lastMinAge: 18n, requesterCommitment: COMMITMENT, verificationCount: 1n });

    const read = await queryContractState("http://localhost:8088", "abc", "/x");

    expect(provider.queryContractState).toHaveBeenCalledWith("abc");
    expect(ledger).toHaveBeenCalledWith(state.data);
    expect(read).toEqual({ verified: true, lastMinAge: 18n, requesterCommitment: COMMITMENT, verificationCount: 1n });
  });

  it("is null for a contract the indexer does not know", async () => {
    provider.queryContractState.mockResolvedValue(null);
    expect(await queryContractState("http://localhost:8088", "abc")).toBeNull();
    expect(ledger).not.toHaveBeenCalled();
  });

  it("throws, rather than answering null, when the compiled contract is not where it was said to be", async () => {
    provider.queryContractState.mockResolvedValue({ data: {} });
    await expect(queryContractState("http://localhost:8088", "abc", "/missing")).rejects.toThrow(
      "Contract assets not found",
    );
    expect(provider.queryContractState).not.toHaveBeenCalled();
  });

  it("gives up on an indexer that accepts the question and never answers", async () => {
    vi.useFakeTimers();
    try {
      provider.queryContractState.mockReturnValue(new Promise(() => {}));
      const read = queryContractState("http://localhost:8088", "abc");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await read).toBeNull();
      expect(console.warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is null, and says so, when the read or the decode fails", async () => {
    provider.queryContractState.mockRejectedValue(new Error("indexer away"));
    expect(await queryContractState("http://localhost:8088", "abc")).toBeNull();
    provider.queryContractState.mockResolvedValue({ data: {} });
    ledger.mockImplementation(() => {
      throw new Error("not this contract's state");
    });
    expect(await queryContractState("http://localhost:8088", "abc")).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe("queryTransaction", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });

  it("asks the indexer for the transaction by its identifier and reads its block", async () => {
    fetchMock.mockResolvedValue(
      reply({
        data: {
          transactions: [{ block: { height: 42 }, contractActions: [{ address: "c0ffee" }, { address: "f00d" }] }],
        },
      }),
    );

    expect(await queryTransaction("http://localhost:8088", "deadbeef")).toEqual({
      blockHeight: 42,
      contractAddresses: ["c0ffee", "f00d"],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8088/api/v4/graphql");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.variables).toEqual({ offset: { identifier: "deadbeef" } });
    expect(body.query).toMatch(/transactions\(offset: \$offset\)/);
  });

  it("reports a transaction that touched no contract as touching none", async () => {
    fetchMock.mockResolvedValue(reply({ data: { transactions: [{ block: { height: 7 } }] } }));
    expect(await queryTransaction("http://localhost:8088", "x")).toEqual({ blockHeight: 7, contractAddresses: [] });
  });

  it("is null when the indexer lists no such transaction, errors, or does not answer", async () => {
    fetchMock.mockResolvedValueOnce(reply({ data: { transactions: [] } }));
    expect(await queryTransaction("http://localhost:8088", "x")).toBeNull();
    fetchMock.mockResolvedValueOnce(reply({ errors: [{ message: "bad" }] }));
    expect(await queryTransaction("http://localhost:8088", "x")).toBeNull();
    fetchMock.mockResolvedValueOnce(reply({}, false));
    expect(await queryTransaction("http://localhost:8088", "x")).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("refused"));
    expect(await queryTransaction("http://localhost:8088", "x")).toBeNull();
  });
});

describe("buildIndexerUrls", () => {
  it("adds the GraphQL and websocket paths to a bare indexer address", () => {
    expect(buildIndexerUrls("http://localhost:8088")).toEqual({
      httpUrl: "http://localhost:8088/api/v4/graphql",
      wsUrl: "ws://localhost:8088/api/v4/graphql/ws",
    });
  });

  it("keeps an address that already names the endpoint, with or without a trailing slash", () => {
    for (const given of ["https://idx.example/api/v4/graphql", "https://idx.example/api/v4/graphql/"]) {
      const { httpUrl, wsUrl } = buildIndexerUrls(given);
      expect(httpUrl.replace(/\/$/, "")).toBe("https://idx.example/api/v4/graphql");
      expect(wsUrl).toBe("wss://idx.example/api/v4/graphql/ws");
    }
  });
});

describe("initializeClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records the endpoints in use, defaults included, once the network answers", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await initializeClient({ network: "standalone" })).toBe(true);
    const state = getClientState();
    expect(state.connected).toBe(true);
    expect(state.config?.indexerUrl).toBe("http://localhost:8088");
    expect(state.config?.proofServerUrl).toBe("http://localhost:6300");
  });
});
