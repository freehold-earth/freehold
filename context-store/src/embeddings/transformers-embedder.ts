/**
 * Transformers Embedder - Local embedding generation via ONNX
 *
 * Runs a feature-extraction model in-process. Weights are fetched once into
 * a local cache; inference itself never leaves the machine.
 */

import {
  type FeatureExtractionPipeline,
  pipeline,
} from "@huggingface/transformers"
import type { Embedder, EmbeddingRole } from "./embedder.js"

export interface TransformersEmbedderOptions {
  /** Model ID or local path (default: Xenova/all-MiniLM-L6-v2) */
  model?: string
  /** Quantization level for model weights (default: q8) */
  dtype?: "fp32" | "fp16" | "q8" | "q4"
  /** Directory for cached model files */
  cacheDir?: string
  /** Only use locally cached model files; never download */
  localFilesOnly?: boolean
  /** Expected embedding dimensionality (default: 384, matching the default model) */
  dimensions?: number
  /** Text prepended to queries, for models trained with task prefixes */
  queryPrefix?: string
  /** Text prepended to documents, for models trained with task prefixes */
  documentPrefix?: string
}

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2"
const DEFAULT_DIMENSIONS = 384

export class TransformersEmbedder implements Embedder {
  readonly dimensions: number
  private options: TransformersEmbedderOptions
  private extractorPromise: Promise<FeatureExtractionPipeline> | undefined

  constructor(options: TransformersEmbedderOptions = {}) {
    this.options = options
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS
  }

  async embed(text: string, role?: EmbeddingRole): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text], role)
    return vector
  }

  async embedBatch(
    texts: string[],
    role: EmbeddingRole = "document",
  ): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return []
    }

    const extractor = await this.getExtractor()
    const prefix =
      (role === "query"
        ? this.options.queryPrefix
        : this.options.documentPrefix) ?? ""
    const inputs = prefix ? texts.map((text) => prefix + text) : texts

    const output = await extractor(inputs, {
      pooling: "mean",
      normalize: true,
    })
    const [, modelDimensions] = output.dims

    if (modelDimensions !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: model produced ${modelDimensions}, expected ${this.dimensions}`,
      )
    }

    const data = output.data as Float32Array
    return texts.map((_, i) =>
      data.slice(i * modelDimensions, (i + 1) * modelDimensions),
    )
  }

  private getExtractor(): Promise<FeatureExtractionPipeline> {
    this.extractorPromise ??= pipeline(
      "feature-extraction",
      this.options.model ?? DEFAULT_MODEL,
      {
        dtype: this.options.dtype ?? "q8",
        cache_dir: this.options.cacheDir,
        local_files_only: this.options.localFilesOnly,
      },
    )
    return this.extractorPromise
  }
}
