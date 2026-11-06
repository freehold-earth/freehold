import { readFileSync } from "node:fs";
import path from "node:path";

const SECRETS = path.resolve(import.meta.dirname, "../infra/secrets");
const CERTS_SH = path.resolve(import.meta.dirname, "../infra/scripts/certs.sh");

/**
 * The certificate and key a demo app's dev server serves with, from the
 * stack's CA: `infra/scripts/certs.sh` writes them into `infra/secrets`, or
 * wherever `SECRETS_DIR` points. An empty variable counts as unset.
 *
 * @param name - The app's service name, which names its files.
 * @throws When the files are missing, naming the directory and the command.
 */
export function tlsFor(name: string): { cert: Buffer; key: Buffer } {
  const dir = process.env.SECRETS_DIR || SECRETS;
  try {
    return {
      cert: readFileSync(path.join(dir, `${name}.crt`)),
      key: readFileSync(path.join(dir, `${name}.key`)),
    };
  } catch (error) {
    throw new Error(
      `no certificate for ${name} in ${dir}: run ${CERTS_SH} ${dir} ` +
        "context-store zkp agent llama-server cardano-api user-app business-app " +
        "(see demo/README.md)",
      { cause: error },
    );
  }
}
