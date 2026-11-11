import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // A fresh node syncs the genesis wallet in minutes and a proof takes a
    // while after that; the on-chain cases wait for both.
    testTimeout: 600_000,
    hookTimeout: 300_000,
    // One file at a time: the files share one network and its genesis
    // wallet, and two transactions built from one wallet at once are refused
    // by the node ("Invalid Transaction: Custom error: 170").
    fileParallelism: false,
  },
});
