/**
 * Unit tests for the `applyResult` portion of execute.ts — the part that
 * translates the agent's result.json into graph mutations. These tests don't
 * touch openclaw or the LLM; they exercise the deterministic apply logic by
 * driving execute() with a stubbed adapter result.
 *
 * applyResult is internal, so we exercise it via the public execute() path
 * with `leafIdOverride` set and a fake adapter shimmed in. Done by importing
 * the module's adapter and patching it for the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import type { Config } from "../src/cli/config.js";
import * as adapter from "../src/openclaw/adapter.js";
import * as workspace from "../src/openclaw/workspace.js";
import * as identity from "../src/openclaw/identity.js";
import { execute } from "../src/task/execute.js";

let db: DB;
let repo: Repo;

function task(title: string, opts: { atomic?: boolean } = {}) {
  return repo.createNode({
    type: "task",
    title,
    body: "",
    status: "open",
    task_kind: "oneoff",
    priority: 0.5,
    schedule: null,
    due_at: null,
    metadata: { atomic: opts.atomic ?? true },
  });
}

const fakeCfg: Config = {
  dbPath: ":memory:",
  port: 0,
  dailyUsdBudget: 0,
  openclawPath: "/fake/openclaw",
  logsDir: "/tmp/trellis-test-logs",
  agentIdentity: "trellis-test",
  openclawMode: "test",
  agentWorkspaceDir: "/tmp/trellis-test-workspace",
  agentStateDir: "/tmp/trellis-test-state",
  sessionsArchiveDir: "/tmp/trellis-test-sessions",
};

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
  vi.spyOn(workspace, "bootstrapWorkspace").mockImplementation(() => ({
    workspaceDir: "/tmp/fake-workspace",
    contextMarkdown: "(context)",
  }));
  vi.spyOn(identity, "ensureAgentIdentity").mockImplementation(() => ({
    configPath: "/tmp/fake-config.json",
    refreshed: { soulMd: false, identityMd: false, agentsMd: false },
  }));
});

afterEach(() => {
  close(db);
  vi.restoreAllMocks();
});

function stubAdapter(result: adapter.AdapterRunResult) {
  vi.spyOn(adapter, "runAgent").mockResolvedValue(result);
}

function adapterResult(over: Partial<adapter.AdapterRunResult> = {}): adapter.AdapterRunResult {
  return {
    ok: true,
    exitCode: 0,
    stdoutPath: "/tmp/out",
    stderrPath: "/tmp/err",
    envelopePath: null,
    resultJsonPath: "/tmp/result.json",
    envelope: null,
    result: null,
    resultSource: "result",
    resultIssues: [],
    durationMs: 100,
    ...over,
  };
}

describe("execute applyResult: status mapping", () => {
  it("maps 'done' to status=done and stores summary", async () => {
    const leaf = task("ship the feature");
    stubAdapter(
      adapterResult({
        result: {
          status: "done",
          summary: "shipped it",
          notes: [],
          new_tasks: [],
          artifacts: [],
        },
      }),
    );

    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });

    expect(out.appliedStatus).toBe("done");
    const refreshed = repo.getNode(leaf.id);
    expect(refreshed?.status).toBe("done");
    expect(refreshed?.metadata.last_session_summary).toBe("shipped it");
    expect(refreshed?.completed_at).not.toBeNull();
  });

  it("maps 'blocked' and stores blocker", async () => {
    const leaf = task("blocked task");
    stubAdapter(
      adapterResult({
        result: {
          status: "blocked",
          summary: "couldn't proceed",
          blocker: "missing api key",
          notes: [],
          new_tasks: [],
          artifacts: [],
        },
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });
    expect(out.appliedStatus).toBe("blocked");
    expect(repo.getNode(leaf.id)?.metadata.last_blocker).toBe("missing api key");
  });

  it("'cancelled' marks node cancelled", async () => {
    const leaf = task("obsoleted task");
    stubAdapter(
      adapterResult({
        result: {
          status: "cancelled",
          summary: "no longer needed",
          notes: [],
          new_tasks: [],
          artifacts: [],
        },
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });
    expect(out.appliedStatus).toBe("cancelled");
    expect(repo.getNode(leaf.id)?.status).toBe("cancelled");
  });

  it("'needs_decomposition' keeps leaf open, attaches new_tasks AS subtasks of leaf", async () => {
    const leaf = task("compound task");
    stubAdapter(
      adapterResult({
        result: {
          status: "needs_decomposition",
          summary: "too big for one session",
          notes: [],
          new_tasks: [
            { title: "step a", body: "first half", priority: 0.7, atomic: true },
            { title: "step b", body: "second half", priority: 0.7, atomic: true },
          ],
          artifacts: [],
        },
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });
    expect(out.appliedStatus).toBe("open");
    expect(out.newTaskIds).toHaveLength(2);
    // Each new task must be subtask_of the leaf.
    const childEdges = repo.edgesTo(leaf.id, "subtask_of");
    const newChildIds = new Set(out.newTaskIds);
    const hits = childEdges.filter((e) => newChildIds.has(e.from_id));
    expect(hits).toHaveLength(2);
  });

  it("notes from result.json are persisted as note nodes linked to the leaf", async () => {
    const leaf = task("noted task");
    stubAdapter(
      adapterResult({
        result: {
          status: "done",
          summary: "done with insight",
          notes: [
            { title: "watch out for X", body: "X is brittle when Y" },
            { title: "perf observation", body: "the slow path is foo()" },
          ],
          new_tasks: [],
          artifacts: [],
        },
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });
    expect(out.newNoteIds).toHaveLength(2);
    for (const id of out.newNoteIds) {
      const n = repo.getNode(id);
      expect(n?.type).toBe("note");
    }
    // Each note should relates_to the leaf.
    const incoming = repo.edgesTo(leaf.id, "relates_to");
    const noteIds = new Set(out.newNoteIds);
    expect(incoming.filter((e) => noteIds.has(e.from_id))).toHaveLength(2);
  });

  it("missing result.json marks the leaf blocked with reason", async () => {
    const leaf = task("opaque failure");
    stubAdapter(
      adapterResult({
        ok: false,
        exitCode: 137,
        result: null,
        resultSource: null,
        resultIssues: ["neither result.json nor progress.json was usable"],
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });
    expect(out.appliedStatus).toBe("blocked");
    expect(repo.getNode(leaf.id)?.metadata.last_block_reason).toContain(
      "neither result.json nor progress.json",
    );
  });

  it("progress.json checkpoint marks leaf in_progress, applies notes/tasks, marks verified", async () => {
    const leaf = task("partial work");
    stubAdapter(
      adapterResult({
        ok: false, // ok=false because resultSource !== "result"
        resultSource: "progress",
        result: {
          status: "in_progress",
          summary: "loaded the schema, drafted half the changes",
          notes: [
            { title: "found existing migration system", body: "uses zod" },
          ],
          new_tasks: [
            { title: "finish migration", body: "complete drafted changes", atomic: true },
          ],
          artifacts: ["draft.ts"],
        },
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });

    expect(out.appliedStatus).toBe("in_progress");
    const refreshed = repo.getNode(leaf.id);
    expect(refreshed?.status).toBe("in_progress");
    expect(refreshed?.verified_at).not.toBeNull();
    expect(refreshed?.metadata.last_session_summary).toMatch(/drafted half/);
    expect(refreshed?.metadata.last_result_source).toBe("progress");
    expect(out.newNoteIds).toHaveLength(1);
    expect(out.newTaskIds).toHaveLength(1);
  });

  it("missing result and missing progress: blocked + NOT verified", async () => {
    const leaf = task("opaque crash");
    stubAdapter(
      adapterResult({
        ok: false,
        exitCode: 137,
        result: null,
        resultSource: null,
        resultIssues: ["neither result.json nor progress.json was usable"],
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });
    expect(out.appliedStatus).toBe("blocked");
    expect(repo.getNode(leaf.id)?.verified_at).toBeNull();
    expect(repo.getNode(leaf.id)?.metadata.last_block_reason).toMatch(
      /neither result.json nor progress.json/,
    );
  });

  it("creates a session node and links it via produced_in_session", async () => {
    const leaf = task("a task");
    stubAdapter(
      adapterResult({
        result: { status: "done", summary: "ok", notes: [], new_tasks: [], artifacts: [] },
      }),
    );
    const out = await execute(repo, fakeCfg, leaf.id, { leafIdOverride: leaf.id });
    const sessionNode = repo.getNode(out.sessionNodeId);
    expect(sessionNode?.type).toBe("session");
    const sessionEdges = repo.edgesTo(leaf.id, "produced_in_session");
    expect(sessionEdges.some((e) => e.from_id === out.sessionNodeId)).toBe(true);
  });
});
