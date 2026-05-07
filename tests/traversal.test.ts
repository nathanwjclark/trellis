import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import {
  ancestors,
  criticalPathLeaf,
  descendants,
} from "../src/graph/traversal.js";

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
});

afterEach(() => {
  close(db);
});

function task(title: string, priority = 0.5) {
  return repo.createNode({
    type: "task",
    title,
    body: "",
    status: "open",
    task_kind: "oneoff",
    priority,
    schedule: null,
    due_at: null,
    metadata: {},
  });
}

function root(title: string) {
  return repo.createNode({
    type: "root_purpose",
    title,
    body: "",
    status: "open",
    task_kind: "continuous",
    priority: 1,
    schedule: null,
    due_at: null,
    metadata: {},
  });
}

function child(c: { id: string }, p: { id: string }, weight = 1) {
  repo.addEdge({
    from_id: c.id,
    to_id: p.id,
    type: "subtask_of",
    weight,
    metadata: {},
  });
}

describe("traversal", () => {
  it("descendants walks the full subtask tree", () => {
    const r = root("make money");
    const a = task("ship product");
    const b = task("write copy");
    const c = task("draft headline");
    child(a, r);
    child(b, a);
    child(c, b);
    const desc = descendants(repo, r.id);
    expect(desc.map((n) => n.title).sort()).toEqual([
      "draft headline",
      "ship product",
      "write copy",
    ]);
  });

  it("ancestors walks up via subtask_of", () => {
    const r = root("make money");
    const a = task("ship product");
    const b = task("write copy");
    child(a, r);
    child(b, a);
    const anc = ancestors(repo, b.id);
    expect(anc.map((n) => n.title)).toEqual(["ship product", "make money"]);
  });

  it("criticalPathLeaf picks highest priority * weight", () => {
    const r = root("make money");
    const high = task("urgent thing", 0.9);
    const low = task("nice thing", 0.2);
    const grand = task("urgent leaf", 0.5);
    child(high, r, 1);
    child(low, r, 1);
    child(grand, high, 1);
    const leaf = criticalPathLeaf(repo, r.id);
    expect(leaf?.title).toBe("urgent leaf");
  });

  it("criticalPathLeaf skips done children", () => {
    const r = root("make money");
    const done = task("done one", 0.9);
    repo.updateNode(done.id, { status: "done" });
    const open = task("open one", 0.5);
    child(done, r, 1);
    child(open, r, 1);
    const leaf = criticalPathLeaf(repo, r.id);
    expect(leaf?.title).toBe("open one");
  });

  it("returns null when nothing is open", () => {
    const r = root("done root");
    repo.updateNode(r.id, { status: "done" });
    expect(criticalPathLeaf(repo, r.id)).toBeNull();
  });
});
