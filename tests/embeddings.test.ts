import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import {
  EmbeddingsRepo,
  cosine,
} from "../src/graph/embeddings.js";

let db: DB;
let repo: Repo;
let emb: EmbeddingsRepo;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
  emb = new EmbeddingsRepo(db, repo);
});

afterEach(() => {
  close(db);
});

describe("cosine", () => {
  it("identical vectors → 1", () => {
    const v = Float32Array.from([1, 0, 0]);
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it("orthogonal → 0", () => {
    expect(
      cosine(Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0])),
    ).toBeCloseTo(0, 5);
  });

  it("zero vector → 0 (no NaN)", () => {
    expect(
      cosine(Float32Array.from([0, 0, 0]), Float32Array.from([1, 0, 0])),
    ).toBe(0);
  });
});

describe("EmbeddingsRepo", () => {
  function task(title: string) {
    return repo.createNode({
      type: "task",
      title,
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
  }

  it("upsert + get round-trips a Float32Array", () => {
    const n = task("a");
    const v = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    emb.upsert({ node_id: n.id, model: "test-model", vector: v, node_revision: 1 });
    const got = emb.get(n.id);
    expect(got).not.toBeNull();
    expect(Array.from(got!.vector)).toEqual([
      0.10000000149011612, // float32 precision
      0.20000000298023224,
      0.30000001192092896,
      0.4000000059604645,
    ]);
    expect(got!.dim).toBe(4);
  });

  it("upsert overwrites the existing row", () => {
    const n = task("a");
    emb.upsert({
      node_id: n.id,
      model: "m",
      vector: Float32Array.from([1, 0]),
      node_revision: 1,
    });
    emb.upsert({
      node_id: n.id,
      model: "m",
      vector: Float32Array.from([0, 1]),
      node_revision: 2,
    });
    const got = emb.get(n.id);
    expect(Array.from(got!.vector)).toEqual([0, 1]);
    expect(got!.node_revision).toBe(2);
  });

  it("nearestNeighbors returns top-K by cosine similarity", () => {
    const a = task("alpha");
    const b = task("beta");
    const c = task("gamma");
    emb.upsert({
      node_id: a.id,
      model: "m",
      vector: Float32Array.from([1, 0, 0]),
      node_revision: 1,
    });
    emb.upsert({
      node_id: b.id,
      model: "m",
      vector: Float32Array.from([0.9, 0.1, 0]),
      node_revision: 1,
    });
    emb.upsert({
      node_id: c.id,
      model: "m",
      vector: Float32Array.from([0, 1, 0]),
      node_revision: 1,
    });
    const neighbors = emb.nearestNeighbors(Float32Array.from([1, 0, 0]), {
      model: "m",
      k: 2,
    });
    expect(neighbors.length).toBe(2);
    expect(neighbors[0]?.node_id).toBe(a.id);
    expect(neighbors[1]?.node_id).toBe(b.id);
    expect(neighbors[0]?.similarity).toBeGreaterThan(neighbors[1]!.similarity);
  });

  it("nearestNeighbors honors excludeNodeIds", () => {
    const a = task("alpha");
    const b = task("beta");
    emb.upsert({
      node_id: a.id,
      model: "m",
      vector: Float32Array.from([1, 0]),
      node_revision: 1,
    });
    emb.upsert({
      node_id: b.id,
      model: "m",
      vector: Float32Array.from([0.99, 0.01]),
      node_revision: 1,
    });
    const out = emb.nearestNeighbors(Float32Array.from([1, 0]), {
      model: "m",
      k: 5,
      excludeNodeIds: new Set([a.id]),
    });
    expect(out.map((n) => n.node_id)).toEqual([b.id]);
  });

  it("nearestNeighbors applies minSimilarity floor", () => {
    const a = task("alpha");
    emb.upsert({
      node_id: a.id,
      model: "m",
      vector: Float32Array.from([1, 0]),
      node_revision: 1,
    });
    const out = emb.nearestNeighbors(Float32Array.from([0, 1]), {
      model: "m",
      k: 5,
      minSimilarity: 0.5,
    });
    expect(out).toEqual([]);
  });

  it("delete removes the row", () => {
    const a = task("alpha");
    emb.upsert({
      node_id: a.id,
      model: "m",
      vector: Float32Array.from([1, 0]),
      node_revision: 1,
    });
    expect(emb.get(a.id)).not.toBeNull();
    emb.delete(a.id);
    expect(emb.get(a.id)).toBeNull();
  });

  it("cascades when the node is deleted", () => {
    const a = task("alpha");
    emb.upsert({
      node_id: a.id,
      model: "m",
      vector: Float32Array.from([1, 0]),
      node_revision: 1,
    });
    db.prepare("DELETE FROM nodes WHERE id = ?").run(a.id);
    expect(emb.get(a.id)).toBeNull();
  });
});
