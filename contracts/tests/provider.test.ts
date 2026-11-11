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

  it("takes a configured Kupo address over the derived one", () => {
    const provider = createProvider({
      ...getDefaultConfig("Custom"),
      providerUrl: "http://localhost:1338",
      kupoUrl: "http://localhost:1443",
    })
    expect(provider).toMatchObject({
      kupoUrl: "http://localhost:1443",
      ogmiosUrl: "http://localhost:1338",
    })
  })

  it("refuses to guess Kupo's address when Ogmios is not on its default port", () => {
    // Derived by swapping the port, Kupo's address would be Ogmios's own.
    expect(() =>
      createProvider({
        ...getDefaultConfig("Custom"),
        providerUrl: "http://localhost:1338",
      }),
    ).toThrow("kupoUrl is required")
  })

  it("uses Blockfrost beyond this machine, and needs its key", () => {
    const config = getDefaultConfig("Preview")
    expect(() => createProvider(config)).toThrow("API key")
    expect(createProvider({ ...config, apiKey: "k" })).toBeInstanceOf(
      Blockfrost,
    )
  })
})
