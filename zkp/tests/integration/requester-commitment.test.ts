/**
 * The age circuit commits to the DID a proof names, on a live Midnight stack.
 *
 * Prerequisites: the standalone stack (docker compose up -d) and a compiled
 * contract (cd contract && pnpm run compact). Skips without the stack and
 * fails without the contract.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgeVerification } from "../../sdk/src/proofs/age-verification.js";
import { queryContractState } from "../../sdk/src/midnight/client.js";
import { destroyWallet, getOrCreateWallet } from "../../sdk/src/midnight/wallet.js";
import { isOnChainProof } from "../../sdk/src/types.js";
import { CONTRACT_ASSETS_PATH, INDEXER_URL, WALLET_SYNC_MS, live, stackIsUp } from "./stack.js";

describe("requester commitment on chain", () => {
  let ready = false;

  beforeAll(async () => {
    ready = await stackIsUp();
  });

  afterAll(async () => {
    await destroyWallet();
  });

  it("writes the DID's commitment to the ledger and refuses a relabelled proof", async () => {
    if (!ready) return;
    const verifier = new AgeVerification(live);
    // A fresh node takes longer to sync the genesis wallet than generate() waits.
    const wallet = await getOrCreateWallet(verifier.walletConfig());
    await wallet.waitForSync(WALLET_SYNC_MS);
    const did = "did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7";
    const proof = await verifier.generate({ birthDate: new Date("1990-01-15"), minAge: 18, requesterDid: did });

    expect(isOnChainProof(proof)).toBe(true);
    if (!isOnChainProof(proof)) return;
    const state = await queryContractState(INDEXER_URL, proof.contractAddress, CONTRACT_ASSETS_PATH);
    expect(state?.requesterCommitment).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(state?.requesterCommitment as Uint8Array).toString("hex")).toBe(
      proof.publicSignals.requesterCommitment,
    );
    expect(proof.publicSignals.requesterDid).toBe(did);
    expect(await verifier.verify(proof)).toBe(true);
    expect(await verifier.verify(proof, did)).toBe(true);

    const relabelled = { ...proof, publicSignals: { ...proof.publicSignals, requesterDid: "did:key:z6MkOther456" } };
    expect(await verifier.verify(relabelled)).toBe(false);
    const { requesterDid: _dropped, ...anonymous } = proof.publicSignals;
    expect(await verifier.verify({ ...proof, publicSignals: anonymous })).toBe(false);
  }, 480_000);
});
