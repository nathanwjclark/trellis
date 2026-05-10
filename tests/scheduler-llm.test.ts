import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import {
  renderGraphForDecision,
  validateDecision,
} from "../src/scheduler/decide_llm.js";

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
});

afterEach(() => {
  close(db);
});

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

function task(
  title: string,
  opts: { atomic?: boolean; status?: "open" | "done" | "blocked" } = {},
) {
  return repo.createNode({
    type: "task",
    title,
    body: "",
    status: opts.status ?? "open",
    task_kind: "oneoff",
    priority: 0.5,
    schedule: null,
    due_at: null,
    metadata: { atomic: opts.atomic ?? false },
  });
}

describe("validateDecision", () => {
  it("rejects malformed input", () => {
    expect(validateDecision(repo, {} as never).ok).toBe(false);
    expect(validateDecision(repo, { action: "execute" }).ok).toBe(false);
    expect(
      validateDecision(repo, { action: "fly_to_moon", node_id: "x" } as never).ok,
    ).toBe(false);
  });

  it("rejects stop — the agent scheduler can no longer choose to stop", () => {
    const v = validateDecision(repo, { action: "stop" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/not a valid action/);
  });

  it("rejects non-UUID node_id", () => {
    const v = validateDecision(repo, { action: "execute", node_id: "abc" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/UUID/);
  });

  it("rejects unknown UUID", () => {
    const v = validateDecision(repo, {
      action: "execute",
      node_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/does not exist/);
  });

  it("rejects done nodes", () => {
    const t = task("a", { atomic: true, status: "done" });
    const v = validateDecision(repo, { action: "execute", node_id: t.id });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/status/);
  });

  it("rejects executing a non-atomic task", () => {
    const t = task("compound", { atomic: false });
    const v = validateDecision(repo, { action: "execute", node_id: t.id });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/not marked atomic/);
  });

  it("rejects cycling an atomic task", () => {
    const t = task("atomic leaf", { atomic: true });
    const v = validateDecision(repo, { action: "cycle", node_id: t.id });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/already atomic/);
  });

  it("rejects acting on a non-task non-root node", () => {
    const concept = repo.createNode({
      type: "concept",
      title: "thing",
      body: "",
      status: "n/a",
      task_kind: null,
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const v = validateDecision(repo, {
      action: "execute",
      node_id: concept.id,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/only 'task' and 'root_purpose'/);
  });

  it("accepts executing an atomic open task", () => {
    const t = task("ready", { atomic: true });
    const v = validateDecision(repo, { action: "execute", node_id: t.id });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.node?.id).toBe(t.id);
  });

  it("accepts cycling a non-atomic open task", () => {
    const t = task("compound", { atomic: false });
    const v = validateDecision(repo, { action: "cycle", node_id: t.id });
    expect(v.ok).toBe(true);
  });

  it("accepts executing a root_purpose (special-case)", () => {
    const r = root("ship money");
    const v = validateDecision(repo, { action: "execute", node_id: r.id });
    expect(v.ok).toBe(true);
  });
});

describe("renderGraphForDecision", () => {
  it("renders one line per node with key fields", () => {
    const r = root("primary");
    const t = task("first leaf", { atomic: true });
    repo.addEdge({
      from_id: t.id,
      to_id: r.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    const text = renderGraphForDecision(repo, null);
    expect(text).toMatch(/\[root_purpose\] open .*"primary"/);
    expect(text).toMatch(/\[task\] open atomic .*"first leaf".*parent=/);
    expect(text.split("\n")).toHaveLength(2);
  });

  it("filters to descendants of the specified root", () => {
    const r1 = root("root one");
    const r2 = root("root two");
    const t1 = task("under r1", { atomic: true });
    const t2 = task("under r2", { atomic: true });
    repo.addEdge({
      from_id: t1.id,
      to_id: r1.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    repo.addEdge({
      from_id: t2.id,
      to_id: r2.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    const text = renderGraphForDecision(repo, r1.id);
    expect(text).toContain("under r1");
    expect(text).not.toContain("under r2");
    expect(text).not.toContain("root two");
  });

  it("marks atomic vs compound for tasks", () => {
    task("alpha-task", { atomic: true });
    task("beta-task", { atomic: false });
    const lines = renderGraphForDecision(repo, null).split("\n");
    const alphaLine = lines.find((l) => l.includes("alpha-task"));
    const betaLine = lines.find((l) => l.includes("beta-task"));
    expect(alphaLine).toMatch(/\] open atomic prio/);
    expect(betaLine).toMatch(/\] open compound prio/);
  });

  it("renders verified=never for a never-verified node", () => {
    task("untouched", { atomic: true });
    const text = renderGraphForDecision(repo, null);
    expect(text).toMatch(/verified=never/);
  });

  it("renders verified=Xs/m/h for a verified node", () => {
    const n = task("checked", { atomic: true });
    repo.markVerified(n.id);
    const text = renderGraphForDecision(repo, null);
    // Just confirm the format isn't 'never' anymore.
    expect(text).not.toMatch(/checked.*verified=never/);
    expect(text).toMatch(/verified=\d+(s|m|h|d)/);
  });
});
