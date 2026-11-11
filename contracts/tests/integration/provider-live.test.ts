/**
 * The provider's network paths against the local Yaci devnet: a query over
 * Kupo, a query and a submit over Ogmios, and a confirmation over Kupo.
 * These are the calls the Cardano library makes through its HTTP client, so
 * this is the test to run when that client's version changes.
 *
 * Prerequisites: docker compose up -d (in contracts/). Skips without it.
 */

import type { LucidEvolution } from "@lucid-evolution/lucid"
import { beforeAll, describe, expect, it } from "vitest"
import {
  getDefaultConfig,
  initializeLucid,
  selectWalletFromSeed,
} from "../../src/lucid/provider.js"
import { fundWallet, TEST_MNEMONIC } from "./devnet.js"

const OGMIOS_URL = process.env.OGMIOS_URL || "http://localhost:1337"

async function devnetIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${OGMIOS_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}

describe.skipIf(!(await devnetIsUp()))("Provider against the devnet", () => {
  let lucid: LucidEvolution
  let address: string

  beforeAll(async () => {
    // Our own start-up path, as the enforcer uses it: the provider it builds
    // and the protocol parameters it fetches from the devnet.
    lucid = await initializeLucid({
      ...getDefaultConfig("Custom"),
      providerUrl: OGMIOS_URL,
    })
    selectWalletFromSeed(lucid, TEST_MNEMONIC)
    address = await lucid.wallet().address()
    await fundWallet(lucid)
  })

  it("reads the wallet's UTxOs over Kupo", async () => {
    await expect
      .poll(async () => (await lucid.wallet().getUtxos()).length, {
        timeout: 30_000,
        interval: 1000,
      })
      .toBeGreaterThan(0)
  })

  it("queries delegation over Ogmios", async () => {
    await expect(lucid.wallet().getDelegation()).resolves.toMatchObject({
      rewards: 0n,
    })
  })

  it("submits a signed payment over Ogmios and sees it confirmed over Kupo", async () => {
    const tx = await lucid
      .newTx()
      .pay.ToAddress(address, { lovelace: 5_000_000n })
      .complete()
    const signed = await tx.sign.withWallet().complete()
    const txHash = await signed.submit()
    expect(txHash).toHaveLength(64)
    await expect(lucid.awaitTx(txHash, 1000)).resolves.toBe(true)
    await expect(
      lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]),
    ).resolves.toHaveLength(1)
  })
})
