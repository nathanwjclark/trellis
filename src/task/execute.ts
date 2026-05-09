import { v4 as uuid } from "uuid";
import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";
import { criticalPathLeaf, ancestors } from "../graph/traversal.js";
import { bootstrapWorkspace } from "../openclaw/workspace.js";
import { runAgent, type AdapterRunResult } from "../openclaw/adapter.js";
import type { Config } from "../cli/config.js";
import { openCallLogger } from "../llm/log.js";

export interface ExecuteOptions {
  /** Override the leaf-selection step and execute this exact node. */
  leafIdOverride?: string;
  /** Thinking level passed to openclaw. Default "medium". */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  /** Subprocess timeout (seconds). */
  timeoutSeconds?: number;
}

export interface ExecuteResult {
  sessionId: string;
  workspaceDir: string;
  leaf: Node;
  selected: "override" | "critical_path";
  durationMs: number;
  adapter: AdapterRunResult;
  /** Status the leaf was transitioned to (or null if no change). */
  appliedStatus: Node["status"] | null;
  /** Note nodes added from result.json. */
  newNoteIds: string[];
  /** Task nodes added from result.json. */
  newTaskIds: string[];
  /** Session node id recording this run. */
  sessionNodeId: string;
  logPath: string;
}

/**
 * Pick a leaf, set up workspace, run openclaw, apply the result back to the
 * graph. One execution = one leaf = one openclaw subprocess.
 */
export async function execute(
  repo: Repo,
  cfg: Config,
  sourceNodeId: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const sessionId = uuid();
  const startedAt = Date.now();
  const logger = openCallLogger({ cycleId: sessionId, purpose: "execute" });

  try {
    // ─── 1. Pick the leaf ────────────────────────────────────────────────
    let leaf: Node;
    let selected: "override" | "critical_path";
    if (opts.leafIdOverride) {
      const n = repo.getNode(opts.leafIdOverride);
      if (!n) throw new Error(`override leaf ${opts.leafIdOverride} not found`);
      leaf = n;
      selected = "override";
    } else {
      const found = criticalPathLeaf(repo, sourceNodeId);
      if (!found) {
        throw new Error(
          `no open critical-path leaf found under ${sourceNodeId}. Is everything done or are there no atomic descendants?`,
        );
      }
      leaf = found;
      selected = "critical_path";
    }
    logger.event("leaf_selected", {
      session_id: sessionId,
      source_id: sourceNodeId,
      leaf_id: leaf.id,
      leaf_title: leaf.title,
      selected,
    });

    // Mark in_progress so concurrent looks at the graph see we're working it.
    if (leaf.status === "open") {
      repo.updateNode(leaf.id, { status: "in_progress" });
    } else {
      repo.touchNode(leaf.id);
    }

    // ─── 2. Find the root purpose for context framing ────────────────────
    const ancList = ancestors(repo, leaf.id);
    const root = ancList.find((n) => n.type === "root_purpose") ?? null;

    // ─── 3. Bootstrap workspace ──────────────────────────────────────────
    const { workspaceDir } = bootstrapWorkspace(repo, {
      sessionsDir: cfg.sessionsDir,
      sessionId,
      leafId: leaf.id,
      rootPurposeId: root?.id ?? null,
    });
    logger.event("workspace_bootstrapped", { workspace_dir: workspaceDir });

    // ─── 4. Record a session row + a session node so the graph has a
    //       first-class reference to this run ─────────────────────────────
    repo.tx(() => {
      repo.recordEvent({
        type: "session_started",
        node_id: leaf.id,
        payload: { session_id: sessionId, workspace: workspaceDir },
      });
      // Also persist a sessions table row.
      const stmt = (repo as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
      }).db.prepare(
        `INSERT INTO sessions (id, task_node_id, workspace_path, transcript_path, status, tool_calls, started_at, metadata)
         VALUES (?, ?, ?, ?, 'running', 0, ?, ?)`,
      );
      stmt.run(sessionId, leaf.id, workspaceDir, null, Date.now(), "{}");
    });

    // Create the session node (used as the target of produced_in_session edges).
    const sessionNode = repo.createNode({
      type: "session",
      title: `session ${sessionId.slice(0, 8)} on "${leaf.title}"`,
      body: `Workspace: ${workspaceDir}`,
      status: "in_progress",
      task_kind: null,
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {
        session_id: sessionId,
        leaf_id: leaf.id,
        workspace_dir: workspaceDir,
      },
    });
    repo.addEdge({
      from_id: sessionNode.id,
      to_id: leaf.id,
      type: "produced_in_session",
      weight: 1,
      metadata: {},
    });

    // ─── 5. Build agent prompt ───────────────────────────────────────────
    // We hand openclaw a minimal one-line prompt — the agent must read the
    // workspace files (AGENTS.md / WORK_CONTEXT.md / RESULT_SCHEMA.md) for
    // the actual work brief. This keeps the openclaw turn boundary tiny.
    const message =
      `You are starting a Trellis worker session in ${workspaceDir}. ` +
      `Read AGENTS.md, WORK_CONTEXT.md, and RESULT_SCHEMA.md, then do the leaf work and write result.json. ` +
      `Leaf: "${leaf.title}".`;

    // ─── 6. Run openclaw ─────────────────────────────────────────────────
    logger.event("agent_run_starting", {
      thinking: opts.thinking ?? "medium",
      timeout_seconds: opts.timeoutSeconds ?? 600,
    });
    const adapter = await runAgent({
      cfg,
      sessionId,
      workspaceDir,
      message,
      thinking: opts.thinking,
      timeoutSeconds: opts.timeoutSeconds,
      onLine: (stream, line) => {
        // High-volume; only log a sample to avoid blowing up the ndjson.
        if (line.length > 0 && Math.random() < 0.05) {
          logger.event("agent_line_sample", { stream, len: line.length });
        }
      },
    });
    logger.event("agent_run_finished", {
      ok: adapter.ok,
      exit_code: adapter.exitCode,
      duration_ms: adapter.durationMs,
      result_status: adapter.result?.status ?? null,
      result_issues: adapter.resultIssues,
    });

    // ─── 7. Apply the result to the graph ───────────────────────────────
    const apply = applyResult(repo, {
      leaf,
      sessionNodeId: sessionNode.id,
      adapter,
    });

    // Update the sessions table row.
    (
      repo as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
      }
    ).db
      .prepare(
        `UPDATE sessions SET status = ?, ended_at = ?, tool_calls = ? WHERE id = ?`,
      )
      .run(
        adapter.ok ? "completed" : "failed",
        Date.now(),
        approximateToolCalls(adapter),
        sessionId,
      );
    repo.updateNode(sessionNode.id, {
      status: adapter.ok ? "done" : "blocked",
    });

    repo.recordEvent({
      type: "session_ended",
      node_id: leaf.id,
      payload: {
        session_id: sessionId,
        ok: adapter.ok,
        applied_status: apply.appliedStatus,
        new_notes: apply.newNoteIds.length,
        new_tasks: apply.newTaskIds.length,
        result_issues: adapter.resultIssues,
      },
    });

    return {
      sessionId,
      workspaceDir,
      leaf,
      selected,
      durationMs: Date.now() - startedAt,
      adapter,
      appliedStatus: apply.appliedStatus,
      newNoteIds: apply.newNoteIds,
      newTaskIds: apply.newTaskIds,
      sessionNodeId: sessionNode.id,
      logPath: logger.path,
    };
  } finally {
    logger.close();
  }
}

interface ApplyArgs {
  leaf: Node;
  sessionNodeId: string;
  adapter: AdapterRunResult;
}

interface ApplyResult {
  appliedStatus: Node["status"] | null;
  newNoteIds: string[];
  newTaskIds: string[];
}

function applyResult(repo: Repo, args: ApplyArgs): ApplyResult {
  const result = args.adapter.result;
  const newNoteIds: string[] = [];
  const newTaskIds: string[] = [];
  let appliedStatus: Node["status"] | null = null;

  if (!result) {
    // No structured result of any kind — neither result.json nor a
    // progress.json checkpoint. Mark blocked so the user can investigate.
    // We deliberately do NOT mark verified here: the agent never produced
    // a verdict or a checkpoint, so this leaf wasn't actually checked.
    repo.updateNode(args.leaf.id, {
      status: "blocked",
      metadata: {
        last_block_reason:
          args.adapter.resultIssues.join("; ") ||
          `openclaw exit ${args.adapter.exitCode}`,
        last_session_id: extractSessionId(args.adapter),
      },
    });
    appliedStatus = "blocked";
    return { appliedStatus, newNoteIds, newTaskIds };
  }

  // The agent produced something — either a final verdict or a partial
  // checkpoint. Either way, it investigated the leaf, so mark it verified
  // (the scheduler treats verified_at as "this node has coverage").
  repo.markVerified(args.leaf.id);

  // Route by where the parsed result came from. result.json is final;
  // progress.json is a partial checkpoint that survived the session
  // ending early.
  const fromCheckpoint = args.adapter.resultSource === "progress";

  let nextStatus: Node["status"];
  if (fromCheckpoint) {
    // Partial work. Keep the leaf in_progress so the loop will re-pick
    // it; capture the agent's state-so-far on metadata for the next
    // session's WORK_CONTEXT.
    nextStatus = "in_progress";
  } else {
    // Final verdict.
    switch (result.status) {
      case "done":
        nextStatus = "done";
        break;
      case "blocked":
        nextStatus = "blocked";
        break;
      case "needs_decomposition":
        // Keep open; the new_tasks the agent surfaced are now the children.
        nextStatus = "open";
        break;
      case "cancelled":
        nextStatus = "cancelled";
        break;
      case "in_progress":
        // Agent wrote in_progress to result.json (unexpected — that
        // status belongs in progress.json). Treat it as a checkpoint.
        nextStatus = "in_progress";
        break;
    }
  }

  repo.updateNode(args.leaf.id, {
    status: nextStatus,
    metadata: {
      last_session_summary: result.summary,
      last_blocker: result.blocker ?? null,
      last_artifacts: result.artifacts,
      last_result_source: args.adapter.resultSource,
    },
  });
  appliedStatus = nextStatus;

  // Persist note nodes.
  for (const note of result.notes) {
    const n = repo.createNode({
      type: "note",
      title: note.title,
      body: note.body,
      status: "n/a",
      task_kind: null,
      priority: 0.4,
      schedule: null,
      due_at: null,
      metadata: { from_session: args.sessionNodeId },
    });
    repo.addEdge({
      from_id: n.id,
      to_id: args.leaf.id,
      type: "relates_to",
      weight: 0.7,
      metadata: { from_phase: "execute" },
    });
    repo.addEdge({
      from_id: n.id,
      to_id: args.sessionNodeId,
      type: "produced_in_session",
      weight: 1,
      metadata: {},
    });
    newNoteIds.push(n.id);
  }

  // Persist new task nodes (subtasks under the leaf for needs_decomposition,
  // or follow-on siblings under the leaf's parent otherwise).
  const parentForNewTasks =
    result.status === "needs_decomposition" ? args.leaf : leafParent(repo, args.leaf);
  for (const t of result.new_tasks) {
    const n = repo.createNode({
      type: "task",
      title: t.title,
      body: t.body,
      status: "open",
      task_kind: "oneoff",
      priority: t.priority ?? 0.5,
      schedule: null,
      due_at: null,
      metadata: {
        from_session: args.sessionNodeId,
        atomic: t.atomic ?? false,
      },
    });
    if (parentForNewTasks) {
      repo.addEdge({
        from_id: n.id,
        to_id: parentForNewTasks.id,
        type: "subtask_of",
        weight: 1,
        metadata: { from_phase: "execute" },
      });
    }
    repo.addEdge({
      from_id: n.id,
      to_id: args.sessionNodeId,
      type: "produced_in_session",
      weight: 1,
      metadata: {},
    });
    newTaskIds.push(n.id);
  }

  return { appliedStatus, newNoteIds, newTaskIds };
}

function leafParent(repo: Repo, leaf: Node): Node | null {
  const e = repo.edgesFrom(leaf.id, "subtask_of");
  if (e.length === 0) return null;
  return repo.getNode(e[0]!.to_id);
}

function approximateToolCalls(adapter: AdapterRunResult): number {
  // Crude estimate from the openclaw envelope, mirroring the vending-bench
  // heuristic: payloads.length - 1 ≈ rounds of tool execution. If meta has
  // an explicit count, prefer it.
  if (!adapter.envelope) return 0;
  const meta = adapter.envelope.meta as Record<string, unknown>;
  const explicit = meta?.toolCalls ?? meta?.toolExecutions;
  if (typeof explicit === "number") return explicit;
  const payloads = adapter.envelope.payloads ?? [];
  return Math.max(0, payloads.length - 1);
}

function extractSessionId(adapter: AdapterRunResult): string | null {
  if (!adapter.envelope) return null;
  const meta = adapter.envelope.meta as Record<string, unknown>;
  if (typeof meta.sessionId === "string") return meta.sessionId;
  return null;
}
