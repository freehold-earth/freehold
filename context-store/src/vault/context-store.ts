/**
 * Context Store - Main entry point for PCI data storage
 */

import type { ContextStoreConfig, VaultConfig } from "./types.js";
import { EncryptedVault } from "./encrypted-vault.js";

export class ContextStore {
  private config: ContextStoreConfig;
  private vaults: Map<string, EncryptedVault> = new Map();

  constructor(config: ContextStoreConfig = {}) {
    this.config = {
      encryption: {
        algorithm: "aes-256-gcm",
        kdf: "argon2id",
        ...config.encryption,
      },
      ...config,
    };
  }

  /**
   * Create a new encrypted vault
   */
  async createVault(name: string, options?: Partial<VaultConfig>): Promise<EncryptedVault> {
    if (this.vaults.has(name)) {
      throw new Error(`Vault "${name}" already exists`);
    }

    const vault = new EncryptedVault({
      name,
      encryption: this.config.encryption,
      ...options,
    });

    await vault.initialize();
    this.vaults.set(name, vault);

    return vault;
  }

  /**
   * Get an existing vault by name
   */
  getVault(name: string): EncryptedVault | undefined {
    return this.vaults.get(name);
  }

  /**
   * List all vault names
   */
  listVaults(): string[] {
    return Array.from(this.vaults.keys());
  }

  /**
   * Delete a vault and all its data
   */
  async deleteVault(name: string): Promise<boolean> {
    const vault = this.vaults.get(name);
    if (!vault) {
      return false;
    }

    await vault.destroy();
    this.vaults.delete(name);
    return true;
  }

  /**
   * Close all vaults and cleanup resources
   */
  async close(): Promise<void> {
    for (const vault of this.vaults.values()) {
      await vault.destroy();
    }
    this.vaults.clear();
  }
}
