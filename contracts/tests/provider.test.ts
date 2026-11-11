/**
 * Which endpoint the provider is given for which service. No network.
 */

import { Blockfrost, Kupmios } from "@lucid-evolution/lucid"
import { describe, expect, it } from "vitest"
import { createProvider, getDefaultConfig } from "../src/lucid/provider.js"

describe("createProvider", () => {
  it("gives the devnet provider Kupo's address as Kupo and Ogmios's as Ogmios", () => {
    const provider = createProvider(getDefaultConfig("Custom"))
    expect(provider).toBeInstanceOf(Kupmios)
    // Swapped, every call is a 404: Ogmios requests posted to Kupo and the reverse.
    expect(provider).toMatchObject({
      kupoUrl: "http://localhost:1442",
      ogmiosUrl: "http://localhost:1337",
    })
  })

  it("uses Blockfrost beyond this machine, and needs its key", () => {
    const config = getDefaultConfig("Preview")
    expect(() => createProvider(config)).toThrow("API key")
    expect(createProvider({ ...config, apiKey: "k" })).toBeInstanceOf(
      Blockfrost,
    )
  })
})
