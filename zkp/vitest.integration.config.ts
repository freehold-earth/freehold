import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // A fresh node syncs the genesis wallet in minutes and a proof takes a
    // while after that; the on-chain cases wait for both.
    testTimeout: 600_000,
    hookTimeout: 300_000,
    // Run sequentially - network tests may conflict
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
