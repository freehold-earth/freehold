import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { tlsFor } from "../../vite-tls";

// The dev server serves TLS only, with the app's certificate from the stack's
// CA, read only when serving: a build or a test run needs none. The port is
// strict because the agent answers this origin alone.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    port: 3001,
    strictPort: true,
    ...(command === "serve" ? { https: tlsFor("business-app") } : {}),
  },
}));
