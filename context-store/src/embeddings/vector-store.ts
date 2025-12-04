/**
 * Vector Store - Semantic search over personal context
 */

import type { EmbeddingConfig, SearchResult } from "../vault/types.js";

export interface VectorEntry {
  id: string;
  vector: Float32Array;
  metadata?: Record<string, unknown>;
}

export class VectorStore {
  private config: EmbeddingConfig;
  private vectors: Map<string, VectorEntry> = new Map();

  constructor(config: EmbeddingConfig = {}) {
    this.config = {
      dimensions: 384, // Default for small embedding models
      ...config,
    };
  }

  /**
   * Add a vector to the store
   */
  async add(id: string, vector: Float32Array, metadata?: Record<string, unknown>): Promise<void> {
    if (vector.length !== this.config.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`
      );
    }

    this.vectors.set(id, { id, vector, metadata });
  }

  /**
   * Generate embedding for text (placeholder - needs actual model)
   */
  async embed(text: string): Promise<Float32Array> {
    // TODO: Integrate with actual embedding model
    // For now, return a placeholder vector
    const vector = new Float32Array(this.config.dimensions!);
    // Simple hash-based placeholder (NOT a real embedding)
    for (let i = 0; i < text.length && i < vector.length; i++) {
      vector[i] = text.charCodeAt(i) / 255;
    }
    return vector;
  }

  /**
   * Search for similar vectors
   */
  async search(query: Float32Array, topK = 10): Promise<SearchResult[]> {
    const results: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];

    for (const entry of this.vectors.values()) {
      const score = this.cosineSimilarity(query, entry.vector);
      results.push({ id: entry.id, score, metadata: entry.metadata });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK).map((r) => ({
      data: {
        id: r.id,
        data: r.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      },
      score: r.score,
    }));
  }

  /**
   * Remove a vector from the store
   */
  async remove(id: string): Promise<boolean> {
    return this.vectors.delete(id);
  }

  /**
   * Get store size
   */
  size(): number {
    return this.vectors.size;
  }

  /**
   * Clear all vectors
   */
  clear(): void {
    this.vectors.clear();
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}
