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

  /** Embed a single text into a normalized vector. */
  embed(text: string, role?: EmbeddingRole): Promise<Float32Array>

  /** Embed multiple texts, preserving input order. */
  embedBatch(texts: string[], role?: EmbeddingRole): Promise<Float32Array[]>
}
