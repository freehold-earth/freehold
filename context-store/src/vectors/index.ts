/**
 * Vector Storage for PCI Context Store
 *
 * Provides semantic search over personal context using sqlite-vec.
 * Embeddings are stored alongside encrypted data for similarity search.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export interface VectorSearchResult {
  /** ID of the matched item */
  id: string;
  /** Distance from query vector (lower = more similar) */
  distance: number;
  /** Any metadata stored with the vector */
  metadata?: Record<string, unknown>;
}

export interface VectorStoreOptions {
  /** Path to database file. Use ":memory:" for in-memory database */
  path: string;
  /** Dimension of embedding vectors (e.g., 384 for all-MiniLM-L6-v2) */
  dimensions: number;
  /** Distance metric: "cosine" or "l2" (default: cosine) */
  distanceMetric?: "cosine" | "l2";
}

/**
 * Vector store for semantic similarity search using sqlite-vec
 */
export class SQLiteVectorStore {
  private db: Database.Database;
  private dimensions: number;
  private stmts!: {
    insert: Database.Statement;
    delete: Database.Statement;
    search: Database.Statement;
    get: Database.Statement;
    count: Database.Statement;
  };

  constructor(options: VectorStoreOptions) {
    this.dimensions = options.dimensions;
    const distanceMetric = options.distanceMetric ?? "cosine";

    // Open database and load sqlite-vec extension
    this.db = new Database(options.path);
    sqliteVec.load(this.db);

    // Verify sqlite-vec is loaded
    const { version } = this.db
      .prepare("select vec_version() as version")
      .get() as { version: string };
    if (!version) {
      throw new Error("Failed to load sqlite-vec extension");
    }

    // Create virtual table for vector search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        item_id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}] distance_metric=${distanceMetric}
      );
    `);

    // Create metadata table for storing additional info
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_metadata (
        item_id TEXT PRIMARY KEY,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Prepare statements
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO vec_embeddings (item_id, embedding)
        VALUES (?, ?)
      `),
      delete: this.db.prepare(`
        DELETE FROM vec_embeddings WHERE item_id = ?
      `),
      search: this.db.prepare(`
        SELECT item_id, distance
        FROM vec_embeddings
        WHERE embedding MATCH ?
        AND k = ?
        ORDER BY distance
      `),
      get: this.db.prepare(`
        SELECT m.item_id, m.metadata, m.created_at, m.updated_at
        FROM embedding_metadata m
        WHERE m.item_id = ?
      `),
      count: this.db.prepare(`
        SELECT COUNT(*) as count FROM vec_embeddings
      `),
    };
  }

  /**
   * Add or update a vector embedding
   *
   * @param id - Unique identifier for this item
   * @param embedding - Vector embedding as number array
   * @param metadata - Optional metadata to store with the vector
   */
  async add(
    id: string,
    embedding: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`
      );
    }

    const floatArray = new Float32Array(embedding);
    const vectorBuffer = Buffer.from(floatArray.buffer);
    const now = new Date().toISOString();

    const transaction = this.db.transaction(() => {
      // Delete existing entry if it exists (vec0 doesn't support INSERT OR REPLACE)
      this.stmts.delete.run(id);

      // Insert vector into vec0 virtual table
      this.stmts.insert.run(id, vectorBuffer);

      // Insert or update metadata
      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO embedding_metadata (item_id, metadata, created_at, updated_at)
        VALUES (?, ?, COALESCE((SELECT created_at FROM embedding_metadata WHERE item_id = ?), ?), ?)
      `
        )
        .run(id, metadata ? JSON.stringify(metadata) : null, id, now, now);
    });

    transaction();
  }

  /**
   * Search for similar vectors using KNN
   *
   * @param queryEmbedding - Query vector to find similar items
   * @param k - Number of results to return
   * @returns Array of search results sorted by similarity
   */
  async search(
    queryEmbedding: number[],
    k: number = 10
  ): Promise<VectorSearchResult[]> {
    if (queryEmbedding.length !== this.dimensions) {
      throw new Error(
        `Query embedding dimension mismatch: expected ${this.dimensions}, got ${queryEmbedding.length}`
      );
    }

    const floatArray = new Float32Array(queryEmbedding);
    const vectorBuffer = Buffer.from(floatArray.buffer);
    const rows = this.stmts.search.all(vectorBuffer, k) as {
      item_id: string;
      distance: number;
    }[];

    return Promise.all(
      rows.map(async (row) => {
        const metaRow = this.stmts.get.get(row.item_id) as {
          metadata: string | null;
        } | undefined;

        return {
          id: row.item_id,
          distance: row.distance,
          metadata: metaRow?.metadata
            ? JSON.parse(metaRow.metadata)
            : undefined,
        };
      })
    );
  }

  /**
   * Delete a vector by ID
   */
  async delete(id: string): Promise<boolean> {
    const transaction = this.db.transaction(() => {
      const result = this.stmts.delete.run(id);
      this.db
        .prepare("DELETE FROM embedding_metadata WHERE item_id = ?")
        .run(id);
      return result.changes > 0;
    });

    return transaction();
  }

  /**
   * Get the total number of vectors stored
   */
  async count(): Promise<number> {
    const result = this.stmts.count.get() as { count: number };
    return result.count;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
