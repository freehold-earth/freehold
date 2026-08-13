/**
 * Semantic Index - Text-level semantic search
 *
 * Composes an Embedder with the sqlite-vec backed vector store so callers
 * work with text in and ranked results out, never raw vectors.
 */

import { SQLiteVectorStore, type VectorSearchResult } from "../vectors/index.js"
import type { Embedder } from "./embedder.js"

export interface SemanticIndexOptions {
  /** Path to database file. Use ":memory:" for an in-memory database */
  path: string
  /** Distance metric: "cosine" or "l2" (default: cosine) */
  distanceMetric?: "cosine" | "l2"
}

export class SemanticIndex {
  private embedder: Embedder
  private store: SQLiteVectorStore

  constructor(embedder: Embedder, options: SemanticIndexOptions) {
    this.embedder = embedder
    this.store = new SQLiteVectorStore({
      path: options.path,
      dimensions: embedder.dimensions,
      distanceMetric: options.distanceMetric,
    })
  }

  /**
   * Add or update a text entry in the index.
   */
  async index(
    id: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const vector = await this.embedder.embed(text)
    await this.store.add(id, Array.from(vector), metadata)
  }

  /**
   * Find the k entries most similar to the query text.
   */
  async query(text: string, k = 10): Promise<VectorSearchResult[]> {
    const vector = await this.embedder.embed(text)
    return this.store.search(Array.from(vector), k)
  }

  /**
   * Remove an entry by ID.
   */
  async remove(id: string): Promise<boolean> {
    return this.store.delete(id)
  }

  /**
   * Number of entries in the index.
   */
  async count(): Promise<number> {
    return this.store.count()
  }

  /**
   * Close the underlying database connection.
   */
  close(): void {
    this.store.close()
  }
}
