/**
 * DUST sponsorship: a NIGHT holder pays another wallet's proof fees.
 *
 * DUST, the fee resource on Midnight, cannot be transferred. What a NIGHT
 * holder can do is register its NIGHT UTXOs for DUST generation and name the
 * DUST address that receives what they generate. A business that wants its
 * customers' proofs to cost them nothing registers its NIGHT to the proof
 * service's DUST address, and the service pays fees from DUST it never had
 * to acquire. Deregistering stops the generation; DUST already generated
 * decays away.
 */

import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { type ManagedWallet, parseDustAddress } from "./wallet.js";

/** A NIGHT UTXO as the facade reports it. */
export type NightUtxo = Parameters<WalletFacade["estimateRegistration"]>[0][number];

/** What one NIGHT UTXO will generate for the receiver once registered. */
export interface DustGenerationEstimate {
  /** The most DUST this UTXO can hold at once, in specks */
  maxCap: bigint;
  /** Specks generated per second until the cap is reached */
  rate: bigint;
  maxCapReachedAt: Date;
}

/** The outcome of registering a sponsor's NIGHT for a receiver's DUST. */
export interface DustSponsorship {
  txId: string;
  utxosRegistered: number;
  /** The registration's own fee, in specks, as estimated before submission */
  fee: bigint;
  generation: DustGenerationEstimate[];
}

/** The sponsor's NIGHT UTXOs that are not yet generating DUST for anyone. */
export function unregisteredNight(utxos: readonly NightUtxo[]): NightUtxo[] {
  return utxos.filter((utxo) => !utxo.meta.registeredForDustGeneration);
}

/** The sponsor's NIGHT UTXOs that are generating DUST. */
export function registeredNight(utxos: readonly NightUtxo[]): NightUtxo[] {
  return utxos.filter((utxo) => utxo.meta.registeredForDustGeneration);
}

/**
 * Register the sponsor's NIGHT so that the DUST it generates accrues to
 * `receiverDustAddress`: the bech32m address a proof service reports as its
 * own. The sponsor's NIGHT is not spent; its UTXOs are recreated, flagged
 * for generation. NIGHT the sponsor receives later generates for the same
 * receiver without another call.
 *
 * All of the sponsor's unregistered NIGHT is used unless `utxos` names the
 * UTXOs to register. The sponsor wallet must be synced.
 *
 * @throws Error when the address is not a DUST address for the wallet's
 *   network, when the sponsor holds no NIGHT to register, or when the
 *   network refuses the registration
 */
export async function designateDust(
  sponsor: ManagedWallet,
  receiverDustAddress: string,
  options: { utxos?: readonly NightUtxo[] } = {},
): Promise<DustSponsorship> {
  const receiver = parseDustAddress(receiverDustAddress, sponsor.network);
  const state = await sponsor.facade.waitForSyncedState();
  const utxos = options.utxos ?? unregisteredNight(state.unshielded.availableCoins);
  if (utxos.length === 0) {
    throw new Error("The sponsor holds no NIGHT that is not already registered for DUST generation");
  }

  const estimate = await sponsor.facade.estimateRegistration(utxos);
  const recipe = await sponsor.facade.registerNightUtxosForDustGeneration(
    utxos,
    sponsor.unshieldedKeystore.getPublicKey(),
    (payload) => sponsor.unshieldedKeystore.signData(payload),
    receiver,
  );
  const tx = await sponsor.facade.finalizeRecipe(recipe);
  const txId = await sponsor.facade.submitTransaction(tx);

  return {
    txId: String(txId),
    utxosRegistered: utxos.length,
    fee: estimate.fee,
    generation: estimate.dustGenerationEstimations.map(({ dust }) => ({
      maxCap: dust.maxCap,
      rate: dust.rate,
      maxCapReachedAt: dust.maxCapReachedAt,
    })),
  };
}

/**
 * Stop the sponsor's NIGHT from generating DUST. All of its registered NIGHT
 * unless `utxos` names the UTXOs to deregister. DUST already generated stays
 * spendable while it decays.
 *
 * @throws Error when the sponsor has no registered NIGHT, or when the
 *   network refuses the deregistration
 */
export async function deregisterDust(
  sponsor: ManagedWallet,
  options: { utxos?: readonly NightUtxo[] } = {},
): Promise<{ txId: string; utxosDeregistered: number }> {
  const state = await sponsor.facade.waitForSyncedState();
  const utxos = options.utxos ?? registeredNight(state.unshielded.availableCoins);
  if (utxos.length === 0) {
    throw new Error("The sponsor holds no NIGHT registered for DUST generation");
  }

  const recipe = await sponsor.facade.deregisterFromDustGeneration(
    [...utxos],
    sponsor.unshieldedKeystore.getPublicKey(),
    (payload) => sponsor.unshieldedKeystore.signData(payload),
  );
  const tx = await sponsor.facade.finalizeRecipe(recipe);
  const txId = await sponsor.facade.submitTransaction(tx);
  return { txId: String(txId), utxosDeregistered: utxos.length };
}
