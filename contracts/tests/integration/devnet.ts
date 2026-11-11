/**
 * What the devnet tests share: the test wallet and how it is funded.
 */

import type { LucidEvolution } from "@lucid-evolution/lucid"

export const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce"

const TOPUP_URL =
  process.env.YACI_ADMIN_URL ||
  "http://localhost:10000/local-cluster/api/addresses/topup"
const ENOUGH_LOVELACE = 50_000_000n

async function balance(lucid: LucidEvolution): Promise<bigint> {
  const utxos = await lucid.wallet().getUtxos()
  return utxos.reduce((sum, utxo) => sum + utxo.assets.lovelace, 0n)
}

/**
 * Make sure the selected wallet holds test ada, asking the devnet's faucet
 * only when it does not: the faucet refuses a second request while its
 * first is still settling.
 */
export async function fundWallet(lucid: LucidEvolution): Promise<void> {
  if ((await balance(lucid)) >= ENOUGH_LOVELACE) return
  const address = await lucid.wallet().address()
  const response = await fetch(TOPUP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, adaAmount: 1000 }),
  })
  if (!response.ok) {
    throw new Error(
      `devnet faucet answered ${response.status}: ${await response.text()}`,
    )
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await balance(lucid)) >= ENOUGH_LOVELACE) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("the devnet faucet's top-up never arrived")
}
