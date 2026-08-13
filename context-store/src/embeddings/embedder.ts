/**
 * Embedder - Turns text into vector embeddings
 */

export interface Embedder {
  /** Dimensionality of the vectors this embedder produces. */
  readonly dimensions: number

  /** Embed a single text into a normalized vector. */
  embed(text: string): Promise<Float32Array>

  /** Embed multiple texts, preserving input order. */
  embedBatch(texts: string[]): Promise<Float32Array[]>
}
