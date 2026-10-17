import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests require a running Yaci devnet and a compiled Aiken
    // blueprint; run them only via `pnpm test:integration`.
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
})
