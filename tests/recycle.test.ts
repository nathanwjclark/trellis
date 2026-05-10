import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import { findRecycleableParent } from "../src/scheduler/recycle.js";

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
});
afterEach(() => close(db));

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
function subtaskOf(child: string, parent: string) {
  repo.addEdge({
    from_id: child,
    to_id: parent,
    type: "subtask_of",
    weight: 1,
    metadata: {},
  });
}

describe("findRecycleableParent", () => {
  it("returns null when leaf has no parent", () => {
    const orphan = task("orphan");
    expect(findRecycleableParent(repo, orphan.id)).toBeNull();
  });

  it("skips when parent is root_purpose", () => {
    const r = root("r");
    const child = task("child");
    subtaskOf(child.id, r.id);
    repo.updateNode(child.id, { status: "done" });
    expect(findRecycleableParent(repo, child.id)).toBeNull();
  });

  it("returns parent when every direct sibling is touched", () => {
    const parent = task("p");
    const a = task("a");
    const b = task("b");
    subtaskOf(a.id, parent.id);
    subtaskOf(b.id, parent.id);
    repo.updateNode(a.id, { status: "done" });
    repo.updateNode(b.id, { status: "in_progress" });
    const result = findRecycleableParent(repo, a.id);
    expect(result?.id).toBe(parent.id);
  });

  it("returns null when at least one sibling is still open", () => {
    const parent = task("p");
    const a = task("a");
    const b = task("b");
    subtaskOf(a.id, parent.id);
    subtaskOf(b.id, parent.id);
    repo.updateNode(a.id, { status: "done" });
    // b stays open
    expect(findRecycleableParent(repo, a.id)).toBeNull();
  });

  it("ignores grandchildren — only direct children matter", () => {
    const parent = task("p");
    const child = task("c");
    const grandchild = task("g");
    subtaskOf(child.id, parent.id);
    subtaskOf(grandchild.id, child.id);
    repo.updateNode(child.id, { status: "in_progress" });
    // grandchild remains open, but it's not a direct child of `parent`
    const r = findRecycleableParent(repo, child.id);
    expect(r?.id).toBe(parent.id);
  });

  it("skips when parent itself is already done/blocked/cancelled", () => {
    const parent = task("p");
    const child = task("c");
    subtaskOf(child.id, parent.id);
    repo.updateNode(child.id, { status: "done" });
    repo.updateNode(parent.id, { status: "done" });
    expect(findRecycleableParent(repo, child.id)).toBeNull();
  });
});
