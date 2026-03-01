/**
 * PCI Contracts
 *
 * Layer 3: Cardano smart contracts for S-PAL policy enforcement
 *
 * @packageDocumentation
 */

// Main enforcer class
export { SPALEnforcer } from "./validators/spal-enforcer.js";

// Helios compilation (legacy)
export { compileValidator, getCompiledScript } from "./compile.js";

// Lucid Evolution provider utilities
export {
  initializeLucid,
  selectWalletFromSeed,
  selectWalletFromPrivateKey,
  getDefaultConfig,
} from "./lucid/provider.js";

// Datum and redeemer builders
export {
  buildPolicyDatum,
  buildAccessRedeemer,
  buildIdentityLinkage,
  buildPaymentCurrency,
  parsePolicyDatum,
  parseIdentityLinkage,
  parsePaymentCurrency,
  serializeDatum,
  serializeRedeemer,
  deserializeDatum,
} from "./lucid/datum-builders.js";

// PaymentCurrency validation and type guards
export {
  validatePaymentCurrency,
  isAda,
  isNativeToken,
  assertNeverCurrency,
} from "./types.js";

// Types
export type {
  // Core types
  IdentityLinkage,
  PaymentCurrency,
  SPALPolicy,
  ValidationRequest,
  ValidationResult,
  CompiledScript,
  // Network/provider types
  Network,
  LucidConfig,
  PolicyUtxo,
  // Legacy types (may be deprecated)
  ProofData,
} from "./types.js";
