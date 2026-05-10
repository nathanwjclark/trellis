import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import { computeIntrospection } from "../src/introspect/compute.js";

let db: DB;
let repo: Repo;
let logsDir: string;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-introspect-"));
});

afterEach(() => {
  close(db);
  fs.rmSync(logsDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<Parameters<Repo["createNode"]>[0]> = {}) {
  return repo.createNode({
    type: "task",
    title: "x",
    body: "",
    status: "open",
    task_kind: "oneoff",
    priority: 0.5,
    schedule: null,
    due_at: null,
    metadata: {},
    ...overrides,
  });
}

function writeLog(name: string, lines: object[]): void {
  fs.writeFileSync(
    path.join(logsDir, name),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("introspect: 1. generative vs revision", () => {
  it("counts revisions across the histogram", () => {
    makeNode({ title: "rev1" });
    const n2 = makeNode({ title: "rev2" });
    repo.updateNode(n2.id, { status: "in_progress" });
    const n3 = makeNode({ title: "rev3" });
    repo.updateNode(n3.id, { status: "in_progress" });
    repo.updateNode(n3.id, { status: "done" });
    const r = computeIntrospection({ repo, logsDir });
    const h = r.generative_vs_revision.revision_histogram;
    expect(h["1"]).toBe(1); // rev1
    expect(h["2"]).toBe(1); // rev2 → 2 (created + 1 update)
    expect(h["3"]).toBe(1); // rev3 → 3
    expect(h["4+"]).toBe(0);
  });

  it("counts creations and updates from events", () => {
    const n = makeNode();
    repo.updateNode(n.id, { status: "done" });
    repo.updateNode(n.id, { priority: 0.9 });
    const r = computeIntrospection({ repo, logsDir });
    expect(r.generative_vs_revision.total_creations).toBe(1);
    expect(r.generative_vs_revision.total_updates).toBe(2);
    expect(r.generative_vs_revision.updates_per_node).toBe(2);
  });
});

describe("introspect: 2. axis balance", () => {
  it("classifies edges across the four primary axes", () => {
    const a = makeNode();
    const b = makeNode();
    const c = makeNode();
    const d = makeNode();
    const e = makeNode();
    repo.addEdge({ from_id: a.id, to_id: b.id, type: "subtask_of", weight: 1, metadata: {} });
    repo.addEdge({ from_id: c.id, to_id: a.id, type: "rationale_for", weight: 1, metadata: {} });
    repo.addEdge({ from_id: d.id, to_id: a.id, type: "risk_of", weight: 1, metadata: {} });
    repo.addEdge({ from_id: a.id, to_id: e.id, type: "ladders_up_to", weight: 1, metadata: {} });
    const r = computeIntrospection({ repo, logsDir });
    expect(r.axis_balance.axes.down.count).toBe(1);
    expect(r.axis_balance.axes.back.count).toBe(1);
    expect(r.axis_balance.axes.forward.count).toBe(1);
    expect(r.axis_balance.axes.up.count).toBe(1);
    // fractions sum ~= 1
    const s = Object.values(r.axis_balance.axes).reduce(
      (sum, a) => sum + a.fraction,
      0,
    );
    expect(s).toBeCloseTo(1, 1);
  });
});

describe("introspect: 3. knowledge capital", () => {
  it("counts thinking vs doing types and research follow-through", () => {
    makeNode({ type: "task" });
    makeNode({ type: "task" });
    makeNode({ type: "concept", title: "c1" });
    makeNode({ type: "rationale", title: "r1" });
    // research: one with body, one without
    makeNode({
      type: "research",
      title: "answered",
      body: "x".repeat(300),
    });
    makeNode({ type: "research", title: "empty", body: "" });
    const r = computeIntrospection({ repo, logsDir });
    expect(r.knowledge_capital.thinking_count).toBe(4); // concept + rationale + 2 research
    expect(r.knowledge_capital.doing_count).toBe(2); // 2 tasks
    expect(r.knowledge_capital.research_followthrough.total).toBe(2);
    expect(r.knowledge_capital.research_followthrough.answered).toBe(1);
    expect(r.knowledge_capital.research_followthrough.unanswered).toBe(1);
  });
});

describe("introspect: 4. re-extrapolation", () => {
  it("counts repeat extrapolations of the same source_id", () => {
    const a = makeNode();
    const b = makeNode();
    writeLog("2026-05-08T10-00-00-000Z__extrapolate__c0000001.ndjson", [
      { t: 1, kind: "logger_opened", purpose: "extrapolate" },
      { t: 2, kind: "cycle_started", source_id: a.id },
      { t: 3, kind: "persisted" },
    ]);
    writeLog("2026-05-08T10-30-00-000Z__extrapolate__c0000002.ndjson", [
      { t: 100, kind: "cycle_started", source_id: a.id }, // re-cycle of a
    ]);
    writeLog("2026-05-08T11-00-00-000Z__extrapolate__c0000003.ndjson", [
      { t: 200, kind: "cycle_started", source_id: b.id },
    ]);
    const r = computeIntrospection({ repo, logsDir });
    expect(r.re_extrapolation.total_extrapolate_calls).toBe(3);
    expect(r.re_extrapolation.on_previously_cycled_nodes).toBe(1);
    expect(r.re_extrapolation.examples).toEqual([
      { source_id: a.id, count: 2 },
    ]);
  });

  it("flags cycles on a parent after a descendant was executed", () => {
    const parent = makeNode({ title: "parent" });
    const child = makeNode({ title: "child" });
    repo.addEdge({
      from_id: child.id,
      to_id: parent.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    // Mark child done at t=50.
    repo.updateNode(child.id, { status: "done", completed_at: 50 });
    // Manually patch completed_at to a known value (updateNode auto-stamps now).
    db.prepare("UPDATE nodes SET completed_at = 50 WHERE id = ?").run(child.id);

    writeLog("2026-05-08T10-00-00-000Z__extrapolate__d0000001.ndjson", [
      { t: 100, kind: "cycle_started", source_id: parent.id },
    ]);
    const r = computeIntrospection({ repo, logsDir });
    expect(r.re_extrapolation.on_parent_after_descendant_executed).toBe(1);
  });
});

describe("introspect: 5. lateral movement", () => {
  it("computes graph distance between consecutive scheduler picks", () => {
    // Build a chain a — b — c — d
    const a = makeNode({ title: "a" });
    const b = makeNode({ title: "b" });
    const c = makeNode({ title: "c" });
    const d = makeNode({ title: "d" });
    repo.addEdge({ from_id: b.id, to_id: a.id, type: "subtask_of", weight: 1, metadata: {} });
    repo.addEdge({ from_id: c.id, to_id: b.id, type: "subtask_of", weight: 1, metadata: {} });
    repo.addEdge({ from_id: d.id, to_id: c.id, type: "subtask_of", weight: 1, metadata: {} });

    writeLog("2026-05-08T10-00-00-000Z__loop__a0000001.ndjson", [
      { t: 1, kind: "scheduler_decided", attempt: 0, action: "execute", node_id: a.id, rationale: "x" },
      { t: 2, kind: "scheduler_decided", attempt: 0, action: "execute", node_id: b.id, rationale: "x" },
      { t: 3, kind: "scheduler_decided", attempt: 0, action: "execute", node_id: d.id, rationale: "x" },
    ]);
    const r = computeIntrospection({ repo, logsDir });
    expect(r.lateral_movement.scheduler_picks).toBe(3);
    // a → b distance 1; b → d distance 2 (via c)
    expect(r.lateral_movement.distance_histogram["1"]).toBe(1);
    expect(r.lateral_movement.distance_histogram["2"]).toBe(1);
  });
});

describe("introspect: 6. scheduler rationales", () => {
  it("classifies rationales by exploit vs explore keywords", () => {
    const n = makeNode();
    writeLog("2026-05-08T10-00-00-000Z__loop__b0000001.ndjson", [
      {
        t: 1,
        kind: "scheduler_decided",
        action: "execute",
        node_id: n.id,
        rationale: "next critical-path leaf — unblocks downstream work.",
      },
      {
        t: 2,
        kind: "scheduler_decided",
        action: "cycle",
        node_id: n.id,
        rationale: "let me reconsider the framing here; we may need a different angle.",
      },
      {
        t: 3,
        kind: "scheduler_decided",
        action: "execute",
        node_id: n.id,
        rationale: "high-priority task needs attention.",
      },
    ]);
    const r = computeIntrospection({ repo, logsDir });
    expect(r.scheduler_rationales.classified.exploit).toBe(1);
    expect(r.scheduler_rationales.classified.explore).toBe(1);
    expect(r.scheduler_rationales.classified.neutral).toBe(1);
    expect(r.scheduler_rationales.examples.exploit[0]).toMatch(/critical-path/);
    expect(r.scheduler_rationales.examples.explore[0]).toMatch(/reconsider/);
  });
});

describe("introspect: integration", () => {
  it("returns a complete report for a tiny graph + tiny logs", () => {
    const root = makeNode({ type: "root_purpose", title: "r", priority: 1 });
    makeNode({ type: "task", title: "t" });
    writeLog("2026-05-08T10-00-00-000Z__extrapolate__e0000001.ndjson", [
      { t: 1, kind: "cycle_started", source_id: root.id },
    ]);
    writeLog("2026-05-08T10-00-00-000Z__loop__l0000001.ndjson", [
      { t: 1, kind: "scheduler_decided", action: "cycle", node_id: root.id, rationale: "go" },
    ]);
    const r = computeIntrospection({ repo, logsDir });
    expect(r.graph_summary.total_nodes).toBe(2);
    expect(r.re_extrapolation.total_extrapolate_calls).toBe(1);
    expect(r.scheduler_rationales.total_decisions).toBe(1);
  });
});
