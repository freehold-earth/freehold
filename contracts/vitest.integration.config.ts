import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60000, // Integration tests may take longer
    hookTimeout: 30000,
    // One file at a time: the files share one devnet and one test wallet,
    // and two transactions built from the same wallet at once spend the same
    // inputs.
    fileParallelism: false,
  },
})
