import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SQLiteVectorStore } from "../src/vectors/index.js"

describe("SQLiteVectorStore", () => {
  let store: SQLiteVectorStore
  const dimensions = 4 // Small dimensions for testing

  beforeEach(() => {
    store = new SQLiteVectorStore({
      path: ":memory:",
      dimensions,
      distanceMetric: "cosine",
    })
  })

  afterEach(() => {
    store.close()
  })

  it("should add and count vectors", async () => {
    await store.add("vec1", [0.1, 0.2, 0.3, 0.4])
    await store.add("vec2", [0.5, 0.6, 0.7, 0.8])

    const count = await store.count()
    expect(count).toBe(2)
  })

  it("should reject vectors with wrong dimensions", async () => {
    await expect(store.add("bad", [0.1, 0.2])).rejects.toThrow(
      "dimension mismatch",
    )
  })

  it("should search for similar vectors", async () => {
    // Add some test vectors
    await store.add("similar", [0.9, 0.8, 0.7, 0.6])
    await store.add("different", [0.1, 0.1, 0.1, 0.1])
    await store.add("also-similar", [0.8, 0.9, 0.8, 0.7])

    // Query with a vector similar to "similar" and "also-similar"
    const results = await store.search([0.85, 0.85, 0.75, 0.65], 3)

    expect(results).toHaveLength(3)
    // Results should be ordered by distance (ascending)
    expect(results[0].distance).toBeLessThanOrEqual(results[1].distance)
    expect(results[1].distance).toBeLessThanOrEqual(results[2].distance)
  })

  it("should store and return metadata", async () => {
    await store.add("with-meta", [0.1, 0.2, 0.3, 0.4], {
      source: "test",
      category: "example",
    })

    const results = await store.search([0.1, 0.2, 0.3, 0.4], 1)

    expect(results[0].id).toBe("with-meta")
    expect(results[0].metadata).toEqual({
      source: "test",
      category: "example",
    })
  })

  it("should delete vectors", async () => {
    await store.add("to-delete", [0.1, 0.2, 0.3, 0.4])
    expect(await store.count()).toBe(1)

    const deleted = await store.delete("to-delete")
    expect(deleted).toBe(true)
    expect(await store.count()).toBe(0)

    const deletedAgain = await store.delete("to-delete")
    expect(deletedAgain).toBe(false)
  })

  it("should update existing vectors", async () => {
    await store.add("updating", [0.1, 0.1, 0.1, 0.1], { version: 1 })
    await store.add("updating", [0.9, 0.9, 0.9, 0.9], { version: 2 })

    // Count should still be 1 (updated, not duplicated)
    expect(await store.count()).toBe(1)

    // Search should find the updated vector
    const results = await store.search([0.9, 0.9, 0.9, 0.9], 1)
    expect(results[0].id).toBe("updating")
    expect(results[0].metadata?.version).toBe(2)
  })

  it("should limit search results with k parameter", async () => {
    // Add 5 vectors
    for (let i = 0; i < 5; i++) {
      await store.add(`vec${i}`, [i * 0.1, i * 0.2, i * 0.1, i * 0.2])
    }

    const results = await store.search([0.5, 0.5, 0.5, 0.5], 2)
    expect(results).toHaveLength(2)
  })
})

describe("SQLiteVectorStore with a persistent database", () => {
  it("should reject opening an existing store with different dimensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "pci-vectors-"))
    const path = join(dir, "store.db")

    const original = new SQLiteVectorStore({ path, dimensions: 4 })
    original.close()

    expect(() => new SQLiteVectorStore({ path, dimensions: 8 })).toThrow(
      "4 dimensions",
    )

    rmSync(dir, { recursive: true, force: true })
  })
})

describe("SQLiteVectorStore with L2 distance", () => {
  let store: SQLiteVectorStore

  beforeEach(() => {
    store = new SQLiteVectorStore({
      path: ":memory:",
      dimensions: 3,
      distanceMetric: "l2",
    })
  })

  afterEach(() => {
    store.close()
  })

  it("should work with L2 distance metric", async () => {
    await store.add("origin", [0, 0, 0])
    await store.add("near", [0.1, 0.1, 0.1])
    await store.add("far", [1, 1, 1])

    const results = await store.search([0, 0, 0], 3)

    expect(results[0].id).toBe("origin")
    expect(results[0].distance).toBeCloseTo(0, 5)
    expect(results[1].id).toBe("near")
    expect(results[2].id).toBe("far")
  })
})

describe("SQLiteVectorStore embedding-space fingerprint", () => {
  const spaceA = '{"model":"a","dims":4}'
  const spaceB = '{"model":"b","dims":4}'

  it("records the fingerprint on create and accepts the same one on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "pci-vectors-"))
    const path = join(dir, "store.db")

    const created = new SQLiteVectorStore({
      path,
      dimensions: 4,
      fingerprint: spaceA,
    })
    expect(created.fingerprint).toBe(spaceA)
    created.close()

    const reopened = new SQLiteVectorStore({
      path,
      dimensions: 4,
      fingerprint: spaceA,
    })
    expect(reopened.fingerprint).toBe(spaceA)
    reopened.close()

    rmSync(dir, { recursive: true, force: true })
  })

  it("refuses to open a store created in a different embedding space", () => {
    const dir = mkdtempSync(join(tmpdir(), "pci-vectors-"))
    const path = join(dir, "store.db")

    new SQLiteVectorStore({ path, dimensions: 4, fingerprint: spaceA }).close()

    expect(
      () => new SQLiteVectorStore({ path, dimensions: 4, fingerprint: spaceB }),
    ).toThrow("different embedding space")

    rmSync(dir, { recursive: true, force: true })
  })

  it("adopts a fingerprint when opening a store that has none yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "pci-vectors-"))
    const path = join(dir, "store.db")

    new SQLiteVectorStore({ path, dimensions: 4 }).close()

    const adopted = new SQLiteVectorStore({
      path,
      dimensions: 4,
      fingerprint: spaceA,
    })
    expect(adopted.fingerprint).toBe(spaceA)
    adopted.close()

    expect(
      () => new SQLiteVectorStore({ path, dimensions: 4, fingerprint: spaceB }),
    ).toThrow("different embedding space")

    rmSync(dir, { recursive: true, force: true })
  })

  it("opens without a fingerprint and reports the stored one", () => {
    const dir = mkdtempSync(join(tmpdir(), "pci-vectors-"))
    const path = join(dir, "store.db")

    new SQLiteVectorStore({ path, dimensions: 4, fingerprint: spaceA }).close()

    const unchecked = new SQLiteVectorStore({ path, dimensions: 4 })
    expect(unchecked.fingerprint).toBe(spaceA)
    unchecked.close()

    rmSync(dir, { recursive: true, force: true })
  })

  it("refuses to open a store with a different distance metric", () => {
    const dir = mkdtempSync(join(tmpdir(), "pci-vectors-"))
    const path = join(dir, "store.db")

    new SQLiteVectorStore({
      path,
      dimensions: 4,
      distanceMetric: "cosine",
    }).close()

    expect(
      () =>
        new SQLiteVectorStore({ path, dimensions: 4, distanceMetric: "l2" }),
    ).toThrow("cosine distance")

    rmSync(dir, { recursive: true, force: true })
  })
})
