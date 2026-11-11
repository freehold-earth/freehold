/**
 * Integration tests for S-PAL validator deployment on Yaci devnet
 *
 * Prerequisites:
 * - Start Yaci devnet: docker compose up -d
 * - Validator built: cd spal_validator && aiken build
 *
 * Run: pnpm test:integration
 */

import { existsSync, readFileSync } from "node:fs"
import { paymentCredentialOf } from "@lucid-evolution/lucid"
import { beforeAll, describe, expect, it } from "vitest"
import {
  getDefaultConfig,
  selectWalletFromSeed,
} from "../../src/lucid/provider.js"
import type { SPALPolicy, ValidationRequest } from "../../src/types.js"
import { SPALEnforcer } from "../../src/validators/spal-enforcer.js"
import { fundWallet, TEST_MNEMONIC } from "./devnet.js"

const YACI_STORE_URL = process.env.YACI_STORE_URL || "http://localhost:8080"
const OGMIOS_URL = process.env.OGMIOS_URL || "http://localhost:1337"
const BLUEPRINT_PATH = "./spal_validator/plutus.json"

// Yaci devkit test mnemonic - 20 pre-funded addresses with 10k ADA each

describe("Devnet Deployment", () => {
  let isDevnetAvailable = false
  let isOgmiosAvailable = false

  beforeAll(async () => {
    // Check if devnet is running (Yaci Store API)
    try {
      const response = await fetch(`${YACI_STORE_URL}/api/v1/blocks/latest`, {
        signal: AbortSignal.timeout(5000),
      })
      isDevnetAvailable = response.ok
    } catch {
      isDevnetAvailable = false
    }

    // Check if ogmios is available (for Lucid operations)
    try {
      const response = await fetch(OGMIOS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "queryNetwork/tip",
          id: 1,
        }),
        signal: AbortSignal.timeout(5000),
      })
      isOgmiosAvailable = response.ok
    } catch {
      isOgmiosAvailable = false
    }
  })

  describe("Prerequisites", () => {
    it("should have Aiken blueprint compiled", () => {
      expect(existsSync(BLUEPRINT_PATH)).toBe(true)
    })

    it("should have valid blueprint structure", () => {
      const content = readFileSync(BLUEPRINT_PATH, "utf-8")
      const blueprint = JSON.parse(content)

      expect(blueprint.preamble).toBeDefined()
      expect(blueprint.preamble.plutusVersion).toBe("v3")
      expect(blueprint.validators).toBeInstanceOf(Array)
      expect(blueprint.validators.length).toBeGreaterThan(0)
    })

    it("should have spend validator in blueprint", () => {
      const content = readFileSync(BLUEPRINT_PATH, "utf-8")
      const blueprint = JSON.parse(content)

      const spendValidator = blueprint.validators.find((v: { title: string }) =>
        v.title.includes("spend"),
      )

      expect(spendValidator).toBeDefined()
      expect(spendValidator.compiledCode).toBeDefined()
      expect(spendValidator.hash).toBeDefined()
      expect(spendValidator.hash).toHaveLength(56) // 28 bytes hex
    })
  })

  describe("Yaci Devnet", () => {
    it("should be accessible", async () => {
      if (!isDevnetAvailable) {
        console.log("Skipping: Yaci devnet not running (docker compose up -d)")
        return
      }

      const response = await fetch(`${YACI_STORE_URL}/api/v1/blocks/latest`)
      expect(response.ok).toBe(true)
    })

    it("should be producing blocks", async () => {
      if (!isDevnetAvailable) {
        console.log("Skipping: Yaci devnet not running")
        return
      }

      const response = await fetch(`${YACI_STORE_URL}/api/v1/blocks/latest`)
      const block = await response.json()

      expect(block).toBeDefined()
      // Block should have a number or height
      expect(block.number ?? block.height ?? block.slot).toBeDefined()
    })

    it("should have epochs", async () => {
      if (!isDevnetAvailable) {
        console.log("Skipping: Yaci devnet not running")
        return
      }

      const response = await fetch(`${YACI_STORE_URL}/api/v1/epochs/latest`)
      expect(response.ok).toBe(true)
    })

    it("should have ogmios available", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not running (check docker compose ports)")
        return
      }

      const response = await fetch(OGMIOS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "queryNetwork/tip",
          id: 1,
        }),
      })
      expect(response.ok).toBe(true)
    })
  })

  describe("Validator Deployment", () => {
    let enforcer: SPALEnforcer
    let testPolicy: SPALPolicy
    let policyTxHash: string

    beforeAll(async () => {
      // Initialize enforcer from blueprint
      enforcer = SPALEnforcer.fromBlueprint()

      // Create test policy
      testPolicy = {
        id: "integration-test-policy",
        ownerPkh: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
        contextScope: "health.records",
        minPayment: 0n,
        maxRetentionMs: 86_400_000,
        requiredProofHash: "",
        identityLinkage: {
          ephemeralRequired: false,
          proofOfRootAllowed: true,
          zkContinuityAllowed: false,
        },
        paymentCurrency: { kind: "Ada" },
      }
    })

    it("should create enforcer from blueprint", () => {
      expect(enforcer.getScriptHash()).toHaveLength(56)
      expect(enforcer.getCborHex()).toBeDefined()
    })

    it("should validate off-chain correctly", async () => {
      const request: ValidationRequest = {
        requesterDid: "did:key:z6MkTest...",
        proofCommitment: "",
        accessTime: Math.floor(Date.now() / 1000),
        paymentAmount: 0n,
      }

      const result = await enforcer.validate(testPolicy, request)
      expect(result.valid).toBe(true)
    })

    it("should deploy validator to devnet", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not available for Lucid")
        return
      }

      // Our own start-up path against the devnet, then a funded test wallet.
      // The endpoint the probe above reached, not a default that may be another devnet.
      await enforcer.initLucid({
        ...getDefaultConfig("Custom"),
        providerUrl: OGMIOS_URL,
      })
      const lucid = selectWalletFromSeed(enforcer.getLucid(), TEST_MNEMONIC)
      await fundWallet(lucid)
      const address = await lucid.wallet().address()

      // The policy is the wallet's own, so the wallet can sign for it later.
      testPolicy = {
        ...testPolicy,
        ownerPkh: paymentCredentialOf(address).hash,
      }
      expect(enforcer.getScriptAddress()).toContain("addr_test")
    })

    it("should create test policy UTxO", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not available")
        return
      }

      const txHash = await enforcer.createPolicyUtxo(testPolicy)
      expect(txHash).toHaveLength(64)
      policyTxHash = txHash
      await expect(enforcer.getLucid().awaitTx(txHash, 1000)).resolves.toBe(
        true,
      )

      const policyUtxos = await enforcer.findPolicyUtxos()
      const created = policyUtxos.find((utxo) => utxo.txHash === txHash)
      // The datum carries the policy's terms; its id is kept off-chain.
      expect(created?.datum).toMatchObject({
        ownerPkh: testPolicy.ownerPkh,
        contextScope: testPolicy.contextScope,
      })
    })

    it("should validate access request on-chain", async () => {
      if (!isOgmiosAvailable) {
        console.log("Skipping: Ogmios not available")
        return
      }

      // The policy this run created: a devnet kept between runs holds older
      // ones for the same wallet.
      const policyUtxo = (await enforcer.findPolicyUtxos()).find(
        (utxo) => utxo.txHash === policyTxHash,
      )
      if (!policyUtxo)
        throw new Error("the policy created above is not on chain")

      // The validator itself runs here: the node accepts the spend only if
      // the Aiken script does.
      const { txCbor } = await enforcer.buildValidationTx(
        testPolicy,
        policyUtxo,
        {
          requesterDid: "did:key:z6MkTest...",
          proofCommitment: "",
          accessTime: Math.floor(Date.now() / 1000),
          paymentAmount: 0n,
        },
      )
      const txHash = await enforcer.signAndSubmitValidationTx(txCbor)
      expect(txHash).toHaveLength(64)
      await expect(enforcer.getLucid().awaitTx(txHash, 1000)).resolves.toBe(
        true,
      )
    })
  })
})
