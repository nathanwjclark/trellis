import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
});

afterEach(() => {
  close(db);
});

describe("Repo node CRUD", () => {
  it("creates and reads a root_purpose", () => {
    const node = repo.createNode({
      type: "root_purpose",
      title: "Make money",
      body: "be financially independent",
      status: "open",
      task_kind: "continuous",
      priority: 1,
      schedule: null,
      due_at: null,
      metadata: { origin: "test" },
    });
    expect(node.id).toMatch(/[0-9a-f-]{36}/);
    const fetched = repo.getNode(node.id);
    expect(fetched?.title).toBe("Make money");
    expect(fetched?.metadata.origin).toBe("test");
    expect(fetched?.revision).toBe(1);
  });

  it("updates bumping revision and stamps completed_at on done", () => {
    const n = repo.createNode({
      type: "task",
      title: "draft proposal",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    expect(n.completed_at).toBeNull();
    const updated = repo.updateNode(n.id, { status: "done" });
    expect(updated.revision).toBe(2);
    expect(updated.completed_at).not.toBeNull();
    expect(updated.status).toBe("done");
  });

  it("filters list by type/status", () => {
    repo.createNode({
      type: "task",
      title: "a",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    repo.createNode({
      type: "task",
      title: "b",
      body: "",
      status: "done",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    repo.createNode({
      type: "concept",
      title: "c",
      body: "",
      status: "n/a",
      task_kind: null,
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    expect(repo.listNodes({ type: "task" })).toHaveLength(2);
    expect(repo.listNodes({ type: "task", status: "open" })).toHaveLength(1);
    expect(repo.listNodes({ type: "concept" })).toHaveLength(1);
  });
});

describe("Repo edges", () => {
  it("creates and queries edges", () => {
    const a = repo.createNode({
      type: "task",
      title: "parent",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const b = repo.createNode({
      type: "task",
      title: "child",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const e = repo.addEdge({
      from_id: b.id,
      to_id: a.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    expect(repo.edgesFrom(b.id, "subtask_of")).toHaveLength(1);
    expect(repo.edgesTo(a.id, "subtask_of")).toHaveLength(1);
    repo.removeEdge(e.id);
    expect(repo.edgesFrom(b.id, "subtask_of")).toHaveLength(0);
  });

  it("dedupes UNIQUE(from,to,type)", () => {
    const a = repo.createNode({
      type: "task",
      title: "a",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const b = repo.createNode({
      type: "task",
      title: "b",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const e1 = repo.addEdge({
      from_id: b.id,
      to_id: a.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    const e2 = repo.addEdge({
      from_id: b.id,
      to_id: a.id,
      type: "subtask_of",
      weight: 0.5,
      metadata: {},
    });
    expect(e2.id).toBe(e1.id);
  });

  it("cascades on node delete", () => {
    const a = repo.createNode({
      type: "task",
      title: "a",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const b = repo.createNode({
      type: "task",
      title: "b",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    repo.addEdge({
      from_id: b.id,
      to_id: a.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    db.prepare("DELETE FROM nodes WHERE id = ?").run(a.id);
    expect(repo.edgesFrom(b.id)).toHaveLength(0);
  });
});

describe("Repo verified_at", () => {
  it("createNode initializes verified_at to null", () => {
    const n = repo.createNode({
      type: "task",
      title: "fresh",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    expect(n.verified_at).toBeNull();
    expect(repo.getNode(n.id)?.verified_at).toBeNull();
  });

  it("markVerified sets verified_at and bumps last_touched_at", () => {
    const n = repo.createNode({
      type: "task",
      title: "fresh",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const before = repo.getNode(n.id)!;
    // Sleep just enough to get a different millisecond.
    const tNow = Date.now();
    repo.markVerified(n.id);
    const after = repo.getNode(n.id)!;
    expect(after.verified_at).not.toBeNull();
    expect(after.verified_at).toBeGreaterThanOrEqual(tNow);
    expect(after.last_touched_at).toBeGreaterThanOrEqual(before.last_touched_at);
  });

  it("can be re-verified (overwrites)", () => {
    const n = repo.createNode({
      type: "task",
      title: "twice",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    repo.markVerified(n.id);
    const first = repo.getNode(n.id)!.verified_at!;
    // Force a 2ms gap so the second timestamp is distinguishable.
    const start = Date.now();
    while (Date.now() - start < 2) {}
    repo.markVerified(n.id);
    const second = repo.getNode(n.id)!.verified_at!;
    expect(second).toBeGreaterThan(first);
  });
});

describe("Repo events", () => {
  it("records node and edge creation events", () => {
    const a = repo.createNode({
      type: "task",
      title: "a",
      body: "",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    repo.updateNode(a.id, { title: "a2" });
    const ev = repo.recentEvents();
    const types = ev.map((e) => e.type);
    expect(types).toContain("node_created");
    expect(types).toContain("node_updated");
  });
});
