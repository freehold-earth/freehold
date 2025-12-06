import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteVectorStore } from "../src/vectors/index.js";

describe("SQLiteVectorStore", () => {
  let store: SQLiteVectorStore;
  const dimensions = 4; // Small dimensions for testing

  beforeEach(() => {
    store = new SQLiteVectorStore({
      path: ":memory:",
      dimensions,
      distanceMetric: "cosine",
    });
  });

  afterEach(() => {
    store.close();
  });

  it("should add and count vectors", async () => {
    await store.add("vec1", [0.1, 0.2, 0.3, 0.4]);
    await store.add("vec2", [0.5, 0.6, 0.7, 0.8]);

    const count = await store.count();
    expect(count).toBe(2);
  });

  it("should reject vectors with wrong dimensions", async () => {
    await expect(store.add("bad", [0.1, 0.2])).rejects.toThrow(
      "dimension mismatch"
    );
  });

  it("should search for similar vectors", async () => {
    // Add some test vectors
    await store.add("similar", [0.9, 0.8, 0.7, 0.6]);
    await store.add("different", [0.1, 0.1, 0.1, 0.1]);
    await store.add("also-similar", [0.8, 0.9, 0.8, 0.7]);

    // Query with a vector similar to "similar" and "also-similar"
    const results = await store.search([0.85, 0.85, 0.75, 0.65], 3);

    expect(results).toHaveLength(3);
    // Results should be ordered by distance (ascending)
    expect(results[0].distance).toBeLessThanOrEqual(results[1].distance);
    expect(results[1].distance).toBeLessThanOrEqual(results[2].distance);
  });

  it("should store and return metadata", async () => {
    await store.add("with-meta", [0.1, 0.2, 0.3, 0.4], {
      source: "test",
      category: "example",
    });

    const results = await store.search([0.1, 0.2, 0.3, 0.4], 1);

    expect(results[0].id).toBe("with-meta");
    expect(results[0].metadata).toEqual({
      source: "test",
      category: "example",
    });
  });

  it("should delete vectors", async () => {
    await store.add("to-delete", [0.1, 0.2, 0.3, 0.4]);
    expect(await store.count()).toBe(1);

    const deleted = await store.delete("to-delete");
    expect(deleted).toBe(true);
    expect(await store.count()).toBe(0);

    const deletedAgain = await store.delete("to-delete");
    expect(deletedAgain).toBe(false);
  });

  it("should update existing vectors", async () => {
    await store.add("updating", [0.1, 0.1, 0.1, 0.1], { version: 1 });
    await store.add("updating", [0.9, 0.9, 0.9, 0.9], { version: 2 });

    // Count should still be 1 (updated, not duplicated)
    expect(await store.count()).toBe(1);

    // Search should find the updated vector
    const results = await store.search([0.9, 0.9, 0.9, 0.9], 1);
    expect(results[0].id).toBe("updating");
    expect(results[0].metadata?.version).toBe(2);
  });

  it("should limit search results with k parameter", async () => {
    // Add 5 vectors
    for (let i = 0; i < 5; i++) {
      await store.add(`vec${i}`, [i * 0.1, i * 0.2, i * 0.1, i * 0.2]);
    }

    const results = await store.search([0.5, 0.5, 0.5, 0.5], 2);
    expect(results).toHaveLength(2);
  });
});

describe("SQLiteVectorStore with L2 distance", () => {
  let store: SQLiteVectorStore;

  beforeEach(() => {
    store = new SQLiteVectorStore({
      path: ":memory:",
      dimensions: 3,
      distanceMetric: "l2",
    });
  });

  afterEach(() => {
    store.close();
  });

  it("should work with L2 distance metric", async () => {
    await store.add("origin", [0, 0, 0]);
    await store.add("near", [0.1, 0.1, 0.1]);
    await store.add("far", [1, 1, 1]);

    const results = await store.search([0, 0, 0], 3);

    expect(results[0].id).toBe("origin");
    expect(results[0].distance).toBeCloseTo(0, 5);
    expect(results[1].id).toBe("near");
    expect(results[2].id).toBe("far");
  });
});
