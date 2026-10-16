import type { FeatureExtractionPipeline } from "@huggingface/transformers"
import { describe, expect, it, vi } from "vitest"
import { TransformersEmbedder } from "../src/embeddings/transformers-embedder.js"

interface FakePipelineCall {
  inputs: string[]
  options: Record<string, unknown>
}

function fakePipeline(dimensions: number, calls: FakePipelineCall[]) {
  const dispose = vi.fn(async () => {})
  const extractor = async (
    inputs: string[],
    options: Record<string, unknown>,
  ) => {
    calls.push({ inputs, options })
    const data = new Float32Array(inputs.length * dimensions)
    for (let i = 0; i < data.length; i++) {
      data[i] = i + 1
    }
    return { dims: [inputs.length, dimensions], data }
  }
  extractor.dispose = dispose
  return extractor as unknown as FeatureExtractionPipeline
}

describe("TransformersEmbedder", () => {
  it("applies role-specific prefixes to inputs", async () => {
    const calls: FakePipelineCall[] = []
    const embedder = new TransformersEmbedder({
      dimensions: 4,
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      pipelineFactory: async () => fakePipeline(4, calls),
    })

    await embedder.embed("hello", "query")
    await embedder.embed("world", "document")
    await embedder.embed("default")

    expect(calls.map((call) => call.inputs)).toEqual([
      ["search_query: hello"],
      ["search_document: world"],
      ["search_document: default"],
    ])
  })

  it("returns one vector per input with the declared dimensionality", async () => {
    const embedder = new TransformersEmbedder({
      dimensions: 3,
      pipelineFactory: async () => fakePipeline(3, []),
    })

    const vectors = await embedder.embedBatch(["a", "b"])

    expect(vectors).toHaveLength(2)
    expect(Array.from(vectors[0])).toEqual([1, 2, 3])
    expect(Array.from(vectors[1])).toEqual([4, 5, 6])
  })

  it("converts non-float32 model output to Float32Array", async () => {
    const embedder = new TransformersEmbedder({
      dimensions: 2,
      pipelineFactory: async () =>
        (async () => ({
          dims: [1, 2],
          data: [0.5, 0.25],
        })) as unknown as FeatureExtractionPipeline,
    })

    const vector = await embedder.embed("hello")

    expect(vector).toBeInstanceOf(Float32Array)
    expect(Array.from(vector)).toEqual([0.5, 0.25])
  })

  it("rejects when the model output does not match the declared dimensions", async () => {
    const embedder = new TransformersEmbedder({
      dimensions: 8,
      pipelineFactory: async () => fakePipeline(4, []),
    })

    await expect(embedder.embed("hello")).rejects.toThrow("dimension mismatch")
  })

  it("retries model loading after a failed attempt", async () => {
    let attempts = 0
    const embedder = new TransformersEmbedder({
      dimensions: 4,
      pipelineFactory: async () => {
        attempts++
        if (attempts === 1) {
          throw new Error("network unavailable")
        }
        return fakePipeline(4, [])
      },
    })

    await expect(embedder.embed("hello")).rejects.toThrow("network unavailable")
    const vector = await embedder.embed("hello")

    expect(attempts).toBe(2)
    expect(vector).toHaveLength(4)
  })

  it("loads the model once across calls", async () => {
    const factory = vi.fn(async () => fakePipeline(4, []))
    const embedder = new TransformersEmbedder({
      dimensions: 4,
      pipelineFactory: factory,
    })

    await embedder.embed("a")
    await embedder.embed("b")

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("disposes the pipeline and reloads on next use", async () => {
    const calls: FakePipelineCall[] = []
    const pipeline = fakePipeline(4, calls)
    const factory = vi.fn(async () => pipeline)
    const embedder = new TransformersEmbedder({
      dimensions: 4,
      pipelineFactory: factory,
    })

    await embedder.embed("a")
    await embedder.dispose()
    await embedder.embed("b")

    expect(pipeline.dispose).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it("disposes safely when the model was never loaded", async () => {
    const embedder = new TransformersEmbedder({
      pipelineFactory: async () => fakePipeline(4, []),
    })

    await expect(embedder.dispose()).resolves.toBeUndefined()
  })

  it("returns an empty result for an empty batch without loading the model", async () => {
    const factory = vi.fn(async () => fakePipeline(4, []))
    const embedder = new TransformersEmbedder({
      dimensions: 4,
      pipelineFactory: factory,
    })

    expect(await embedder.embedBatch([])).toEqual([])
    expect(factory).not.toHaveBeenCalled()
  })
})
