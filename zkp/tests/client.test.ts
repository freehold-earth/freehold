import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above every other statement, so what its factories
// reference must be hoisted with it.
const { provider, ledger } = vi.hoisted(() => ({
  provider: { queryContractState: vi.fn() },
  ledger: vi.fn(),
}));
// The package is a dependency of sdk/, not of this test package, so it is
// named by the path the client resolves it through.
vi.mock("../sdk/node_modules/@midnight-ntwrk/midnight-js-indexer-public-data-provider", () => ({
  indexerPublicDataProvider: () => provider,
}));
vi.mock("../sdk/src/midnight/contract-module.js", () => ({
  loadContractModule: async () => ({ ledger }),
  resolveContractAssetsPath: (p?: string) => p ?? "/managed",
}));

import { queryContractState, queryTransaction } from "../sdk/src/midnight/client.js";

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
    fetchMock.mockResolvedValue(reply({ data: { transactions: [{ block: { height: 42 } }] } }));

    expect(await queryTransaction("http://localhost:8088", "deadbeef")).toEqual({ blockHeight: 42 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8088/api/v4/graphql");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.variables).toEqual({ offset: { identifier: "deadbeef" } });
    expect(body.query).toMatch(/transactions\(offset: \$offset\)/);
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
