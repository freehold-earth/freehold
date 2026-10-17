/**
 * PCI Contracts
 *
 * Layer 3: Cardano smart contracts for S-PAL policy enforcement
 *
 * @packageDocumentation
 */

// Helios compilation (legacy)
export { compileValidator, getCompiledScript } from "./compile.js"
// Datum and redeemer builders
export {
  buildAccessRedeemer,
  buildIdentityLinkage,
  buildPaymentCurrency,
  buildPolicyDatum,
  deserializeDatum,
  parseIdentityLinkage,
  parsePaymentCurrency,
  parsePolicyDatum,
  serializeDatum,
  serializeRedeemer,
} from "./lucid/datum-builders.js"

// Lucid Evolution provider utilities
export {
  getDefaultConfig,
  initializeLucid,
  selectWalletFromPrivateKey,
  selectWalletFromSeed,
} from "./lucid/provider.js"
// Types
export type {
  CompiledScript,
  // Core types
  IdentityLinkage,
  LucidConfig,
  // Network/provider types
  Network,
  PaymentCurrency,
  PolicyUtxo,
  // Legacy types (may be deprecated)
  ProofData,
  SPALPolicy,
  ValidationRequest,
  ValidationResult,
} from "./types.js"

// PaymentCurrency validation and type guards
export {
  assertNeverCurrency,
  isAda,
  isNativeToken,
  validatePaymentCurrency,
} from "./types.js"
// Main enforcer class
export { SPALEnforcer } from "./validators/spal-enforcer.js"
