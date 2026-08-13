import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Embedder } from "../src/embeddings/embedder.js"
import { SemanticIndex } from "../src/embeddings/semantic-index.js"

class FakeEmbedder implements Embedder {
  readonly dimensions = 4
  private vectors: Record<string, number[]>

  constructor(vectors: Record<string, number[]>) {
    this.vectors = vectors
  }

  async embed(text: string): Promise<Float32Array> {
    const vector = this.vectors[text]
    if (!vector) {
      throw new Error(`No fake vector defined for text: ${text}`)
    }
    return Float32Array.from(vector)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((text) => this.embed(text)))
  }
}

describe("SemanticIndex", () => {
  let index: SemanticIndex

  const embedder = new FakeEmbedder({
    "cats are great pets": [1, 0.9, 0, 0],
    "dogs need daily walks": [0, 0, 1, 0.9],
    "the stock market fell": [0, 0.1, 0, 1],
    "tell me about cats": [0.9, 1, 0, 0],
  })

  beforeEach(() => {
    index = new SemanticIndex(embedder, { path: ":memory:" })
  })

  afterEach(() => {
    index.close()
  })

  it("should index text and count entries", async () => {
    await index.index("a", "cats are great pets")
    await index.index("b", "dogs need daily walks")

    expect(await index.count()).toBe(2)
  })

  it("should rank semantically similar text first", async () => {
    await index.index("cats", "cats are great pets")
    await index.index("dogs", "dogs need daily walks")
    await index.index("stocks", "the stock market fell")

    const results = await index.query("tell me about cats", 3)

    expect(results).toHaveLength(3)
    expect(results[0].id).toBe("cats")
    expect(results[0].distance).toBeLessThan(results[1].distance)
  })

  it("should limit results to k", async () => {
    await index.index("cats", "cats are great pets")
    await index.index("dogs", "dogs need daily walks")
    await index.index("stocks", "the stock market fell")

    const results = await index.query("tell me about cats", 2)

    expect(results).toHaveLength(2)
  })

  it("should round-trip metadata", async () => {
    await index.index("cats", "cats are great pets", { source: "note-1" })

    const results = await index.query("tell me about cats", 1)

    expect(results[0].metadata).toEqual({ source: "note-1" })
  })

  it("should update an entry when indexed again under the same id", async () => {
    await index.index("a", "cats are great pets")
    await index.index("a", "the stock market fell")

    expect(await index.count()).toBe(1)
    const results = await index.query("tell me about cats", 1)
    expect(results[0].id).toBe("a")
  })

  it("should remove entries", async () => {
    await index.index("a", "cats are great pets")

    expect(await index.remove("a")).toBe(true)
    expect(await index.count()).toBe(0)
    expect(await index.remove("a")).toBe(false)
  })
})
