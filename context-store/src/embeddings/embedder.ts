/**
 * Embedder - Turns text into vector embeddings
 */

/**
 * How the text will be used. Some models embed retrieval queries and
 * indexed documents differently (e.g. via task-specific prompt prefixes).
 */
export type EmbeddingRole = "query" | "document"

export interface Embedder {
  /** Dimensionality of the vectors this embedder produces. */
  readonly dimensions: number

  /**
   * Stable identifier of the embedding space this embedder produces vectors
   * in: model, revision, quantisation, dimensionality, pooling and any role
   * prefixes. Two embedders with the same fingerprint produce comparable
   * vectors; a store created with one fingerprint refuses to open with
   * another, so vectors from different models are never mixed silently.
   */
  readonly fingerprint?: string

  /** Embed a single text into a normalized vector. */
  embed(text: string, role?: EmbeddingRole): Promise<Float32Array>

  /** Embed multiple texts, preserving input order. */
  embedBatch(texts: string[], role?: EmbeddingRole): Promise<Float32Array[]>

  /** Release any resources held by the embedder, if it holds any. */
  dispose?(): Promise<void>
}
