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

import type { UtxoWithMeta, WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { type ManagedWallet, parseDustAddress } from "./wallet.js";

/** A NIGHT UTXO as the facade reports it. */
export type NightUtxo = UtxoWithMeta;

/** Which of the sponsor's NIGHT UTXOs to act on; all eligible ones when absent. */
export interface DustUtxoOptions {
  utxos?: readonly NightUtxo[];
}

/** How a first registration is paid for when its NIGHT has not yet generated the fee. */
export interface DustRegistrationOptions extends DustUtxoOptions {
  /**
   * How long to wait for the NIGHT to generate its own registration fee,
   * polling the estimate, before giving up. Zero by default: the call then
   * fails at once, saying how long the wait would be.
   */
  waitForFeeMs?: number;
  /** How often to re-estimate while waiting; 10 seconds by default */
  pollIntervalMs?: number;
}

/**
 * Thrown when a first registration's NIGHT has not yet generated enough
 * DUST to pay the registration's own fee, with the wait still needed.
 */
export class DustRegistrationNotReadyError extends Error {
  constructor(
    readonly fee: bigint,
    readonly generated: bigint,
    readonly readyInSeconds: number,
  ) {
    super(
      `The NIGHT has generated ${generated} of the ${fee} specks the registration costs; about ${readyInSeconds}s more are needed`,
    );
    this.name = "DustRegistrationNotReadyError";
  }
}

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
 * UTXOs to register. A first registration pays its own fee out of the DUST
 * the NIGHT has generated since it arrived, so a fresh UTXO may need a wait
 * (`waitForFeeMs`). NIGHT that is already registered may be named in
 * `utxos` to redirect its generation; that is paid with a DUST spend from
 * the sponsor's own balance and needs the proof server. Name every
 * registered UTXO when redirecting, since one left out keeps generating for
 * its current receiver. The sponsor wallet must be synced.
 *
 * @throws Error when the address is not a DUST address for the wallet's
 *   network, when the sponsor holds no NIGHT to register, or when the
 *   network refuses the registration
 * @throws DustRegistrationNotReadyError when the NIGHT has not generated
 *   the registration's fee within the wait allowed
 */
export async function designateDust(
  sponsor: ManagedWallet,
  receiverDustAddress: string,
  options: DustRegistrationOptions = {},
): Promise<DustSponsorship> {
  const receiver = parseDustAddress(receiverDustAddress, sponsor.network);
  const state = await sponsor.facade.waitForSyncedState();
  const utxos = options.utxos ?? unregisteredNight(state.unshielded.availableCoins);
  if (utxos.length === 0) {
    throw new Error(
      "The sponsor holds no NIGHT that is not already registered for DUST generation; name registered UTXOs to redirect them",
    );
  }
  const redirect = utxos.some((utxo) => utxo.meta.registeredForDustGeneration);

  const estimate = redirect
    ? await sponsor.facade.estimateRegistration(utxos)
    : await waitForRegistrationFee(sponsor, utxos, options);

  const recipe = await sponsor.facade.registerNightUtxosForDustGeneration(
    utxos,
    sponsor.unshieldedKeystore.getPublicKey(),
    (payload) => sponsor.unshieldedKeystore.signData(payload),
    receiver,
  );
  // A redirect carries no fee payment of its own, so it is balanced with
  // a DUST spend; a first registration pays from the NIGHT's generation
  const toFinalize = redirect
    ? await sponsor.facade.balanceUnprovenTransaction(
        recipe.transaction,
        { shieldedSecretKeys: sponsor.zswapSecretKeys, dustSecretKey: sponsor.dustSecretKey },
        { ttl: new Date(Date.now() + 30 * 60 * 1000), tokenKindsToBalance: ["dust"] },
      )
    : recipe;
  const tx = await sponsor.facade.finalizeRecipe(toFinalize);
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

type RegistrationEstimate = Awaited<ReturnType<WalletFacade["estimateRegistration"]>>;

/**
 * The registration estimate once the NIGHT has generated the fee, polling
 * until it has or the wait allowed runs out.
 */
async function waitForRegistrationFee(
  sponsor: ManagedWallet,
  utxos: readonly NightUtxo[],
  options: DustRegistrationOptions,
): Promise<RegistrationEstimate> {
  const deadline = Date.now() + (options.waitForFeeMs ?? 0);
  const interval = options.pollIntervalMs ?? 10_000;
  for (;;) {
    const estimate = await sponsor.facade.estimateRegistration(utxos);
    const generated = estimate.dustGenerationEstimations.reduce(
      (sum, { dust }) => sum + dust.generatedNow,
      0n,
    );
    if (generated >= estimate.fee) return estimate;

    const rate = estimate.dustGenerationEstimations.reduce((sum, { dust }) => sum + dust.rate, 0n);
    const readyInSeconds =
      rate === 0n ? Number.POSITIVE_INFINITY : Number((estimate.fee - generated + rate - 1n) / rate);
    const remaining = deadline - Date.now();
    if (remaining <= 0 || readyInSeconds * 1000 > remaining) {
      throw new DustRegistrationNotReadyError(estimate.fee, generated, readyInSeconds);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
  }
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
  options: DustUtxoOptions = {},
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
