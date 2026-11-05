/**
 * The age circuit commits to the DID a proof names, on a live Midnight stack.
 *
 * Prerequisites: the standalone stack (docker compose up -d) and a compiled
 * contract (cd contract && pnpm run compact). Skips without either. Fails
 * today on the circuit call ("expected instance of StateValue", #111); the
 * logged ledger state is what the SDK's commitment decoding should be
 * pinned to once that is fixed.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { AgeVerification } from "../../sdk/src/proofs/age-verification.js";
import { isNetworkAvailable, queryContractState } from "../../sdk/src/midnight/client.js";
import { destroyWallet, getOrCreateWallet } from "../../sdk/src/midnight/wallet.js";
import { isOnChainProof } from "../../sdk/src/types.js";

const PROOF_SERVER_URL = process.env.MIDNIGHT_PROOF_SERVER_URL || "http://localhost:6300";
const INDEXER_URL = process.env.MIDNIGHT_INDEXER_URL || "http://localhost:8088";
const NODE_URL = process.env.MIDNIGHT_NODE_URL || "ws://localhost:9944";
// The dev preset's public genesis wallet, which already holds DUST.
const GENESIS_SEED = "0".repeat(63) + "1";

const CONTRACT_ASSETS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "contract", "managed");

describe("requester commitment on chain", () => {
  let ready = false;

  beforeAll(async () => {
    const up = await isNetworkAvailable({ proofServerUrl: PROOF_SERVER_URL, networkCheckTimeoutMs: 5000 });
    ready = up && existsSync(CONTRACT_ASSETS_PATH);
    if (!ready) console.log("Skipping: needs the Midnight stack and a compiled contract");
  });

  it("writes the DID's commitment to the ledger and refuses a relabelled proof", async () => {
    if (!ready) return;
    const verifier = new AgeVerification({
      proofServerUrl: PROOF_SERVER_URL,
      indexerUrl: INDEXER_URL,
      nodeUrl: NODE_URL,
      walletSeed: GENESIS_SEED,
      contractAssetsPath: CONTRACT_ASSETS_PATH,
    });
    // A fresh node takes longer to sync the genesis wallet than generate() waits.
    const wallet = await getOrCreateWallet(verifier.walletConfig());
    await wallet.waitForSync(240_000);
    const did = "did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7";
    const proof = await verifier.generate({ birthDate: new Date("1990-01-15"), minAge: 18, requesterDid: did });

    expect(isOnChainProof(proof)).toBe(true);
    if (!isOnChainProof(proof)) return;
    const state = await queryContractState(INDEXER_URL, proof.contractAddress);
    console.log("ledger state as the indexer returns it:", JSON.stringify(state));
    expect(proof.publicSignals.requesterDid).toBe(did);
    expect(await verifier.verify(proof)).toBe(true);
    expect(await verifier.verify(proof, did)).toBe(true);

    const relabelled = { ...proof, publicSignals: { ...proof.publicSignals, requesterDid: "did:key:z6MkOther456" } };
    expect(await verifier.verify(relabelled)).toBe(false);
    const { requesterDid: _dropped, ...anonymous } = proof.publicSignals;
    expect(await verifier.verify({ ...proof, publicSignals: anonymous })).toBe(false);
    await destroyWallet();
  }, 480_000);
});
