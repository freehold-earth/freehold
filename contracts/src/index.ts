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
  parsePolicyDatum,
  parseIdentityLinkage,
  serializeDatum,
  serializeRedeemer,
  deserializeDatum,
} from "./lucid/datum-builders.js";

// Types
export type {
  // Core types
  IdentityLinkage,
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
