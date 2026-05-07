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

describe("redirectEdgeRefs", () => {
  it("redirects outgoing edges from new → existing", () => {
    const existing = task("existing");
    const dup = task("duplicate");
    const sibling = task("sibling");
    repo.addEdge({ from_id: dup.id, to_id: sibling.id, type: "depends_on", weight: 1, metadata: {} });
    repo.redirectEdgeRefs(dup.id, existing.id);
    expect(repo.edgesFrom(existing.id, "depends_on")).toHaveLength(1);
    expect(repo.edgesFrom(dup.id, "depends_on")).toHaveLength(0);
  });

  it("redirects incoming edges to new → existing", () => {
    const existing = task("existing");
    const dup = task("duplicate");
    const child = task("child");
    repo.addEdge({ from_id: child.id, to_id: dup.id, type: "subtask_of", weight: 1, metadata: {} });
    repo.redirectEdgeRefs(dup.id, existing.id);
    expect(repo.edgesTo(existing.id, "subtask_of")).toHaveLength(1);
    expect(repo.edgesTo(dup.id, "subtask_of")).toHaveLength(0);
  });

  it("removes self-loops produced by the rewrite", () => {
    const existing = task("existing");
    const dup = task("duplicate");
    repo.addEdge({ from_id: dup.id, to_id: existing.id, type: "depends_on", weight: 1, metadata: {} });
    const stats = repo.redirectEdgeRefs(dup.id, existing.id);
    expect(stats.selfLoopsRemoved).toBe(1);
    expect(repo.edgesFrom(existing.id)).toHaveLength(0);
  });

  it("dedupes when the existing already has the same edge", () => {
    const existing = task("existing");
    const dup = task("duplicate");
    const sib = task("sibling");
    repo.addEdge({ from_id: existing.id, to_id: sib.id, type: "depends_on", weight: 1, metadata: {} });
    repo.addEdge({ from_id: dup.id, to_id: sib.id, type: "depends_on", weight: 1, metadata: {} });
    repo.redirectEdgeRefs(dup.id, existing.id);
    expect(repo.edgesFrom(existing.id, "depends_on")).toHaveLength(1);
    expect(repo.edgesFrom(dup.id, "depends_on")).toHaveLength(0);
  });

  it("noop on self-redirect", () => {
    const a = task("a");
    const stats = repo.redirectEdgeRefs(a.id, a.id);
    expect(stats).toEqual({
      rewrittenFrom: 0,
      rewrittenTo: 0,
      selfLoopsRemoved: 0,
    });
  });
});

describe("deleteNode", () => {
  it("removes the node and cascades edges", () => {
    const a = task("a");
    const b = task("b");
    repo.addEdge({ from_id: a.id, to_id: b.id, type: "subtask_of", weight: 1, metadata: {} });
    repo.deleteNode(a.id);
    expect(repo.getNode(a.id)).toBeNull();
    expect(repo.edgesFrom(a.id)).toHaveLength(0);
  });

  it("records a node_archived event", () => {
    const a = task("a");
    repo.deleteNode(a.id);
    const ev = repo.recentEvents().find((e) => e.type === "node_archived");
    expect(ev).toBeDefined();
    expect(ev?.node_id).toBe(a.id);
  });
});
