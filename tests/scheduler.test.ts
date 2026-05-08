import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import { decideNextAction } from "../src/scheduler/decide.js";

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
});

afterEach(() => {
  close(db);
});

function root(title: string, priority = 1) {
  return repo.createNode({
    type: "root_purpose",
    title,
    body: "",
    status: "open",
    task_kind: "continuous",
    priority,
    schedule: null,
    due_at: null,
    metadata: {},
  });
}

function task(title: string, opts: { atomic?: boolean; status?: "open" | "done" | "blocked"; priority?: number } = {}) {
  return repo.createNode({
    type: "task",
    title,
    body: "",
    status: opts.status ?? "open",
    task_kind: "oneoff",
    priority: opts.priority ?? 0.5,
    schedule: null,
    due_at: null,
    metadata: { atomic: opts.atomic ?? false },
  });
}

function child(c: { id: string }, p: { id: string }, weight = 1) {
  repo.addEdge({ from_id: c.id, to_id: p.id, type: "subtask_of", weight, metadata: {} });
}

describe("decideNextAction", () => {
  it("stops with reason when no roots exist", () => {
    const d = decideNextAction(repo);
    expect(d.kind).toBe("stop");
    if (d.kind === "stop") expect(d.reason).toMatch(/no open root/);
  });

  it("stops when the only root has no open descendants", () => {
    const r = root("solo");
    repo.updateNode(r.id, { status: "done" });
    const d = decideNextAction(repo);
    expect(d.kind).toBe("stop");
  });

  it("execute on an atomic open leaf", () => {
    const r = root("ship");
    const t = task("atomic leaf", { atomic: true });
    child(t, r);
    const d = decideNextAction(repo);
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") expect(d.node.id).toBe(t.id);
  });

  it("cycle on a non-atomic leaf with no children", () => {
    const r = root("ship");
    const t = task("non-atomic leaf", { atomic: false });
    child(t, r);
    const d = decideNextAction(repo);
    expect(d.kind).toBe("cycle");
    if (d.kind === "cycle") expect(d.node.id).toBe(t.id);
  });

  it("descends past non-leaf intermediates to the lowest atomic leaf", () => {
    const r = root("ship");
    const mid = task("mid", { atomic: false });
    const leaf = task("leaf", { atomic: true });
    child(mid, r);
    child(leaf, mid);
    const d = decideNextAction(repo);
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") expect(d.node.id).toBe(leaf.id);
  });

  it("picks highest-priority open root by default", () => {
    const lo = root("low", 0.2);
    const hi = root("high", 0.9);
    const lt = task("low task", { atomic: true });
    const ht = task("high task", { atomic: true });
    child(lt, lo);
    child(ht, hi);
    const d = decideNextAction(repo);
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") expect(d.node.id).toBe(ht.id);
  });

  it("respects rootId override", () => {
    const a = root("alpha", 0.9);
    const b = root("beta", 0.5);
    const at = task("atask", { atomic: true });
    const bt = task("btask", { atomic: true });
    child(at, a);
    child(bt, b);
    const d = decideNextAction(repo, { rootId: b.id });
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") expect(d.node.id).toBe(bt.id);
  });

  it("blocks a leaf and re-decides if cycle didn't produce children", () => {
    const r = root("ship");
    const t = task("non-atomic", { atomic: false });
    child(t, r);
    // Simulate that we already cycled this leaf.
    repo.recordEvent({
      type: "cycle_completed",
      node_id: t.id,
      payload: { phase: "extrapolate" },
    });
    const d = decideNextAction(repo);
    // Should mark t blocked and then stop (no other open work).
    expect(d.kind).toBe("stop");
    expect(repo.getNode(t.id)?.status).toBe("blocked");
  });
});
