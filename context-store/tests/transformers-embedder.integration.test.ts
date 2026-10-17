import { afterAll, describe, expect, it } from "vitest"
import { SemanticIndex } from "../src/embeddings/semantic-index.js"
import { TransformersEmbedder } from "../src/embeddings/transformers-embedder.js"

// Downloads the default model (~25 MB) on first run; opt in explicitly.
const integration = process.env.PCI_EMBEDDING_INTEGRATION === "1"

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

describe.skipIf(!integration)("TransformersEmbedder (integration)", () => {
  const embedder = new TransformersEmbedder()
  const timeout = 120_000

  it("produces normalized vectors of the declared dimensionality", {
    timeout,
  }, async () => {
    const vector = await embedder.embed("hello world")

    expect(vector).toHaveLength(embedder.dimensions)
    expect(embedder.dimensions).toBe(384)

    const norm = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0),
    )
    expect(norm).toBeCloseTo(1, 3)
  })

  it("embeds related text closer than unrelated text", {
    timeout,
  }, async () => {
    const [cat, feline, finance] = await embedder.embedBatch([
      "the cat sat on the mat",
      "a feline rested on the rug",
      "quarterly earnings exceeded analyst expectations",
    ])

    const related = cosineSimilarity(cat, feline)
    const unrelated = cosineSimilarity(cat, finance)

    expect(related).toBeGreaterThan(unrelated)
  })

  it("returns identical vectors for identical text", { timeout }, async () => {
    const first = await embedder.embed("deterministic output")
    const second = await embedder.embed("deterministic output")

    expect(cosineSimilarity(first, second)).toBeCloseTo(1, 5)
  })

  it("embedBatch matches individual embed calls", { timeout }, async () => {
    const [batched] = await embedder.embedBatch(["consistency check"])
    const single = await embedder.embed("consistency check")

    expect(cosineSimilarity(batched, single)).toBeCloseTo(1, 5)
  })

  it("rejects when configured dimensions do not match the model output", {
    timeout,
  }, async () => {
    const mismatched = new TransformersEmbedder({ dimensions: 999 })

    await expect(mismatched.embed("hello")).rejects.toThrow(
      "dimension mismatch",
    )
  })

  describe("end-to-end with SemanticIndex", () => {
    const index = new SemanticIndex(embedder, { path: ":memory:" })

    afterAll(() => {
      index.close()
    })

    it("ranks the semantically related document first", {
      timeout,
    }, async () => {
      await index.index("pets", "My cat loves sleeping in the sun")
      await index.index("cooking", "Slice the onions and fry them gently")
      await index.index("finance", "The stock market fell sharply today")

      const results = await index.query("what do felines enjoy doing", 3)

      expect(results).toHaveLength(3)
      expect(results[0].id).toBe("pets")
    })
  })
})
