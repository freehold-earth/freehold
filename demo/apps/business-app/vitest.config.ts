import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // CI runs the workspace's tests before its build, so the identity
      // package has no dist yet; test against its source instead.
      "@freehold-earth/identity": fileURLToPath(
        new URL("../../../identity/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
