import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { deployAndVerifyAge, REQUESTER_COMMITMENT_LENGTH } from "../sdk/src/midnight/contract-deployer.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContractModule, resolveContractAssetsPath } from "../sdk/src/midnight/contract-module.js";

// Fixture modules live inside the package: the test runner resolves a dynamic
// import() itself and only finds files under the package root.
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".tmp");

describe("ContractDeployer - resolveContractAssetsPath", () => {
  it("should return explicit path when it exists", () => {
    // Use the platform temp directory (works on all OSes)
    const tmp = tmpdir();
    const result = resolveContractAssetsPath(tmp);
    expect(result).toBe(tmp);
  });

  it("should throw when explicit path does not exist", () => {
    expect(() =>
      resolveContractAssetsPath("/nonexistent/path/to/managed")
    ).toThrow("Contract assets not found at");
  });

  it("should include compilation instructions in error message", () => {
    expect(() => resolveContractAssetsPath("/nonexistent/managed")).toThrow(
      /compact/i
    );
  });
});

describe("ContractModule - loadContractModule", () => {
  it("refuses a directory whose module is not a compiled contract", async () => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
    const managed = mkdtempSync(join(FIXTURE_ROOT, "not-a-contract-"));
    try {
      mkdirSync(join(managed, "contract"));
      // Node 22.0 to 22.6 reads a .js file as CommonJS unless a package.json says otherwise.
      writeFileSync(join(managed, "package.json"), '{ "type": "module" }\n');
      writeFileSync(join(managed, "contract", "index.js"), "export const Contract = class {};\n");
      await expect(loadContractModule(managed)).rejects.toThrow("must export Contract and ledger()");
    } finally {
      rmSync(managed, { recursive: true, force: true });
    }
  });

  it("says where it looked when there is no module at all", async () => {
    const managed = mkdtempSync(join(tmpdir(), "empty-managed-"));
    await expect(loadContractModule(managed)).rejects.toThrow(/No compiled contract module found/);
  });
});

describe("ContractDeployer - deployAndVerifyAge", () => {
  it("refuses a requester commitment that is not the circuit's 32 bytes, before touching the wallet", async () => {
    const wallet = {
      dustBalance: () => {
        throw new Error("wallet must not be consulted");
      },
    } as unknown as Parameters<typeof deployAndVerifyAge>[0];
    const config = {} as Parameters<typeof deployAndVerifyAge>[1];
    const today = new Date("2024-12-04");
    await expect(
      deployAndVerifyAge(wallet, config, new Date("1990-01-15"), 18, today, "/x", new Uint8Array(31)),
    ).rejects.toThrow(RangeError);
    expect(REQUESTER_COMMITMENT_LENGTH).toBe(32);
  });

  it("should be importable", async () => {
    // Verify the function exists and is exported
    const mod = await import("../sdk/src/midnight/contract-deployer.js");
    expect(typeof mod.deployAndVerifyAge).toBe("function");
  });

  it("should export DeploymentResult type shape", async () => {
    // Type-level test: verify the DeploymentResult interface shape
    const result = {
      txId: "abc123",
      contractAddress: "0x1234",
      blockHeight: 42,
      verified: true,
      dustFee: 1_000n,
    } satisfies import("../sdk/src/midnight/contract-deployer.js").DeploymentResult;

    expect(result.txId).toBe("abc123");
    expect(result.contractAddress).toBe("0x1234");
    expect(result.blockHeight).toBe(42);
    expect(result.verified).toBe(true);
  });
});
