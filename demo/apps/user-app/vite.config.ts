import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server serves TLS only, with the app's certificate from the stack's
// CA: ../infra/scripts/certs.sh writes it (SECRETS_DIR names another place).
// Read only when serving; a build or a test run needs no certificate.
function certificate(): { cert: Buffer; key: Buffer } {
  const dir =
    process.env.SECRETS_DIR || path.resolve(import.meta.dirname, "../../../infra/secrets");
  const cert = path.join(dir, "user-app.crt");
  const key = path.join(dir, "user-app.key");
  if (!existsSync(cert) || !existsSync(key)) {
    throw new Error(
      `no certificate for user-app in ${dir}: run ../infra/scripts/certs.sh (see the README)`,
    );
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    port: 3000,
    ...(command === "serve" ? { https: certificate() } : {}),
  },
}));
