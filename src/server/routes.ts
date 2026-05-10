import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import type { Repo } from "../graph/repo.js";
import type { Edge, Node } from "../graph/schema.js";
import type { EventBus } from "./events.js";
import { computeIntrospection } from "../introspect/compute.js";

export interface AppDeps {
  repo: Repo;
  bus: EventBus;
  /** Filesystem root holding per-session workspaces. */
  sessionsDir: string;
  /** Filesystem root for per-call ndjson logs. */
  logsDir: string;
  /** Agent workspace root (the cwd of openclaw subprocesses). Used to
   *  surface artifacts the agent wrote into <workspace>/.trellis/. */
  agentWorkspaceDir: string;
}

/**
 * Build the Hono app. Exported as a factory so tests can drive it via
 * `app.fetch(req)` without spinning up a real HTTP server.
 */
export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Permissive CORS for local-only ingress; this server is meant to bind to
  // 127.0.0.1. If we ever expose it more broadly, lock this down.
  app.use("/api/*", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));

  /** Full graph dump: every node + every edge. Cheap until graphs get big. */
  app.get("/api/graph", (c) => {
    const nodes = deps.repo.listNodes();
    const edges = nodesToEdges(deps, nodes);
    return c.json({
      nodes: nodes.map(serializeNode),
      edges: edges.map(serializeEdge),
      counts: {
        nodes: nodes.length,
        edges: edges.length,
      },
    });
  });

  /** Single node detail with its in/out edges expanded. */
  app.get("/api/nodes/:id", (c) => {
    const id = c.req.param("id");
    const node = deps.repo.getNode(id);
    if (!node) return c.json({ error: "node not found" }, 404);
    const out = deps.repo.edgesFrom(id);
    const inc = deps.repo.edgesTo(id);
    return c.json({
      node: serializeNode(node),
      edges: {
        outgoing: out.map((e) => serializeEdge(e)),
        incoming: inc.map((e) => serializeEdge(e)),
      },
    });
  });

  /** Plain-text export of the whole graph as a hierarchical markdown
   *  document. Each root_purpose becomes an H1, its subtask tree nests
   *  under it (subtask_of edges followed depth-first); each node block
   *  shows type, status, short id, body, and outgoing non-subtask edges
   *  as cross-references. Suitable for offline review with text tools. */
  app.get("/api/export/text", (c) => {
    const nodes = deps.repo.listNodes();
    const allEdges = nodesToEdges(deps, nodes);
    const text = renderGraphAsMarkdown(nodes, allEdges);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="trellis-export-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.md"`,
    );
    return c.body(text);
  });

  /** List artifact files openclaw agents have written, grouped by
   *  source. Default sources: the agent workspace's `.trellis/` subdir
   *  (where Trellis-driven leaves drop deliverables) and per-session
   *  sandboxes under sessionsDir. Excludes the transient brief files
   *  (CURRENT_LEAF.md / WORK_CONTEXT.md / etc.) that get overwritten
   *  every session. */
  app.get("/api/artifacts", (c) => {
    return c.json({ groups: collectArtifactGroups(deps) });
  });

  /** Read one artifact's content. The `path` query is interpreted relative
   *  to one of the registered group roots; we hard-fail any path that
   *  escapes its root so a curl can't read /etc/passwd through this. */
  app.get("/api/artifacts/file", (c) => {
    const group = c.req.query("group") ?? "";
    const rel = c.req.query("path") ?? "";
    if (!group || !rel) {
      return c.json({ error: "group and path required" }, 400);
    }
    const groups = collectArtifactGroups(deps);
    const grp = groups.find((g) => g.id === group);
    if (!grp) return c.json({ error: "unknown group" }, 404);
    const abs = path.resolve(grp.root, rel);
    if (!abs.startsWith(path.resolve(grp.root) + path.sep)) {
      return c.json({ error: "path escapes root" }, 400);
    }
    const stat = safeStat(abs);
    if (!stat || !stat.isFile()) {
      return c.json({ error: "not found" }, 404);
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      return c.json(
        {
          error: `too large (${stat.size} bytes; cap ${MAX_ARTIFACT_BYTES})`,
        },
        413,
      );
    }
    const text = readIfExists(abs) ?? "";
    return c.json({
      group,
      path: rel,
      size: stat.size,
      mtime: stat.mtimeMs,
      content: text,
    });
  });

  /** Six-stat introspection report on graph + scheduler behavior.
   *  Surfaces "temperature collapse" — front-loaded extrapolation
   *  followed by pure execute-the-critical-path-leaf with no
   *  revisiting, no lateral movement, no scheduler rationale that
   *  mentions reconsidering anything. See src/introspect/compute.ts. */
  app.get("/api/introspect", (c) => {
    const sinceParam = c.req.query("since");
    const sinceMs = parseSinceMs(sinceParam);
    return c.json(
      computeIntrospection({
        repo: deps.repo,
        logsDir: deps.logsDir,
        sinceMs,
      }),
    );
  });

  /** Recent events. Useful for first-paint of the activity feed; subsequent
   *  updates flow over /api/events/stream. */
  app.get("/api/events", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const events = deps.repo.recentEvents(Math.max(1, Math.min(1000, limit)));
    return c.json({ events });
  });

  /** List recent cycles (or loop runs, sweeps, executes — anything that
   *  opened a per-call logger). Aggregates the on-disk ndjson files by
   *  short-id, returning the most-recent cycles first with summary metadata.
   */
  app.get("/api/cycles", (c) => {
    const limit = Math.min(
      Number.parseInt(c.req.query("limit") ?? "50", 10) || 50,
      500,
    );
    const cycles = listCycles(deps.logsDir).slice(0, limit);
    return c.json({ cycles });
  });

  /** Detail for a single cycle: parsed events from all of its ndjson logs +
   *  parsed sidecar JSON dumps. Accept either the short id (8 chars) or the
   *  full UUID; we always store/match by short id internally. */
  app.get("/api/cycles/:id", (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{4,40}$/i.test(id)) {
      return c.json({ error: "invalid cycle id" }, 400);
    }
    const shortId = id.slice(0, 8).toLowerCase();
    const detail = readCycleDetail(deps.logsDir, shortId);
    if (!detail) return c.json({ error: "cycle not found" }, 404);
    return c.json(detail);
  });

  /** Session detail: workspace path, log file sizes, the agent's result.json
   *  if it exists, and a small snapshot of stdout/stderr. */
  app.get("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "invalid session id" }, 400);
    const dir = path.resolve(deps.sessionsDir, id);
    if (!fs.existsSync(dir)) {
      return c.json({ error: "session workspace not found" }, 404);
    }
    return c.json({
      session_id: id,
      workspace_dir: dir,
      stdout_size: safeStat(path.join(dir, "openclaw.stdout.log"))?.size ?? 0,
      stderr_size: safeStat(path.join(dir, "openclaw.stderr.log"))?.size ?? 0,
      has_result: fs.existsSync(path.join(dir, "result.json")),
      has_envelope: fs.existsSync(path.join(dir, "envelope.json")),
      result: readJsonIfExists(path.join(dir, "result.json")),
      files: listWorkspaceFiles(dir),
    });
  });

  /** Session log fetch: returns the full stdout and stderr as text. Cheap;
   *  most workspace logs are under a megabyte. Use /log/stream for live tail. */
  app.get("/api/sessions/:id/log", (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "invalid session id" }, 400);
    const dir = path.resolve(deps.sessionsDir, id);
    if (!fs.existsSync(dir)) {
      return c.json({ error: "session workspace not found" }, 404);
    }
    return c.json({
      stdout: readIfExists(path.join(dir, "openclaw.stdout.log")) ?? "",
      stderr: readIfExists(path.join(dir, "openclaw.stderr.log")) ?? "",
    });
  });

  /** SSE tail of a session's stdout + stderr. We poll the file every 500ms
   *  and emit only newly-appended bytes. Stops on client disconnect. */
  app.get("/api/sessions/:id/log/stream", (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "invalid session id" }, 400);
    const dir = path.resolve(deps.sessionsDir, id);
    const stdoutPath = path.join(dir, "openclaw.stdout.log");
    const stderrPath = path.join(dir, "openclaw.stderr.log");
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      // Initial dump: send everything that's already on disk so the client
      // gets fast first-paint, then tail from there.
      let stdoutOffset = 0;
      let stderrOffset = 0;
      const initialOut = readIfExists(stdoutPath) ?? "";
      const initialErr = readIfExists(stderrPath) ?? "";
      if (initialOut)
        await stream.writeSSE({
          event: "stdout",
          data: JSON.stringify({ chunk: initialOut, initial: true }),
        });
      if (initialErr)
        await stream.writeSSE({
          event: "stderr",
          data: JSON.stringify({ chunk: initialErr, initial: true }),
        });
      stdoutOffset = Buffer.byteLength(initialOut, "utf8");
      stderrOffset = Buffer.byteLength(initialErr, "utf8");

      while (!closed) {
        await stream.sleep(500);
        if (closed) break;
        const tailOut = readSinceOffset(stdoutPath, stdoutOffset);
        if (tailOut.text) {
          await stream
            .writeSSE({
              event: "stdout",
              data: JSON.stringify({ chunk: tailOut.text }),
            })
            .catch(() => {
              closed = true;
            });
          stdoutOffset = tailOut.newOffset;
        }
        const tailErr = readSinceOffset(stderrPath, stderrOffset);
        if (tailErr.text) {
          await stream
            .writeSSE({
              event: "stderr",
              data: JSON.stringify({ chunk: tailErr.text }),
            })
            .catch(() => {
              closed = true;
            });
          stderrOffset = tailErr.newOffset;
        }
      }
    });
  });

  /** SSE stream of new events. Polls the events table at the bus's cadence. */
  app.get("/api/events/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      const unsub = deps.bus.subscribe((event) => {
        if (closed) return;
        stream
          .writeSSE({ event: event.type, data: JSON.stringify(event) })
          .catch(() => {
            closed = true;
          });
      });
      // Initial heartbeat so the client knows the connection is live.
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ t: Date.now() }) });
      // Hold the response open until the client disconnects.
      while (!closed) {
        await stream.sleep(15_000);
        if (!closed) {
          await stream
            .writeSSE({ event: "ping", data: JSON.stringify({ t: Date.now() }) })
            .catch(() => {
              closed = true;
            });
        }
      }
      unsub();
    });
  });

  return app;
}

// ─── Serialization helpers ──────────────────────────────────────────────

function serializeNode(n: Node) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    status: n.status,
    task_kind: n.task_kind,
    priority: n.priority,
    schedule: n.schedule,
    due_at: n.due_at,
    created_at: n.created_at,
    updated_at: n.updated_at,
    last_touched_at: n.last_touched_at,
    completed_at: n.completed_at,
    verified_at: n.verified_at,
    revision: n.revision,
    metadata: n.metadata,
  };
}

function serializeEdge(e: Edge) {
  return {
    id: e.id,
    from_id: e.from_id,
    to_id: e.to_id,
    type: e.type,
    weight: e.weight,
    metadata: e.metadata,
    created_at: e.created_at,
  };
}

// ─── Cycle log helpers ──────────────────────────────────────────────────

/** Parse a log filename like
 *  `2026-05-07T21-52-11-485Z__extrapolate__63c74ff0.ndjson` or
 *  `…__63c74ff0__tool_use_input.json` into structured fields. */
interface ParsedLogFile {
  filename: string;
  ts: string;
  purpose: string;
  shortId: string;
  isNdjson: boolean;
  /** For sidecar dumps, the dump name after the short id. */
  dumpName: string | null;
  startedAt: number;
}

function parseLogFilename(name: string): ParsedLogFile | null {
  // Patterns:
  //   <ts>__<purpose>__<shortId>.ndjson
  //   <ts>__<purpose>__<shortId>__<dump>.json
  const m = name.match(
    /^([0-9TZ\-]+)__([a-zA-Z0-9_\-]+)__([0-9a-f]{8})(?:__([a-zA-Z0-9_\-]+))?\.(ndjson|json)$/,
  );
  if (!m) return null;
  const ts = m[1]!;
  const purpose = m[2]!;
  const shortId = m[3]!;
  const dumpName = m[4] ?? null;
  const ext = m[5]!;
  const startedAt = Date.parse(ts.replace(/-(\d{3}Z)$/, ".$1").replace(/-/g, ":").replace("T:", "T")) || 0;
  // The replace dance above handles our timestamp encoding. We replaced
  // `:` and `.` with `-` when writing, so we need to invert that. The
  // simpler approach: split into parts and reassemble.
  return {
    filename: name,
    ts,
    purpose,
    shortId,
    isNdjson: ext === "ndjson",
    dumpName,
    startedAt: parseLogTimestamp(ts),
  };
}

function parseLogTimestamp(ts: string): number {
  // ts like "2026-05-07T21-52-11-485Z" → "2026-05-07T21:52:11.485Z"
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return 0;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

interface CycleSummary {
  short_id: string;
  started_at: number;
  purposes: string[];
  ndjson_files: number;
  dump_files: number;
}

function listCycles(logsDir: string): CycleSummary[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  const byShort = new Map<string, ParsedLogFile[]>();
  for (const e of entries) {
    const p = parseLogFilename(e);
    if (!p) continue;
    const arr = byShort.get(p.shortId) ?? [];
    arr.push(p);
    byShort.set(p.shortId, arr);
  }
  const out: CycleSummary[] = [];
  for (const [shortId, files] of byShort) {
    files.sort((a, b) => a.startedAt - b.startedAt);
    const purposes = Array.from(new Set(files.map((f) => f.purpose)));
    const startedAt = files[0]?.startedAt ?? 0;
    out.push({
      short_id: shortId,
      started_at: startedAt,
      purposes,
      ndjson_files: files.filter((f) => f.isNdjson).length,
      dump_files: files.filter((f) => !f.isNdjson).length,
    });
  }
  out.sort((a, b) => b.started_at - a.started_at);
  return out;
}

interface CyclePhase {
  purpose: string;
  filename: string;
  started_at: number;
  events: Record<string, unknown>[];
}

interface CycleDetail {
  short_id: string;
  started_at: number;
  phases: CyclePhase[];
  dumps: { phase: string; name: string; filename: string; content: unknown }[];
}

function readCycleDetail(logsDir: string, shortId: string): CycleDetail | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return null;
  }
  const matches = entries
    .map(parseLogFilename)
    .filter((p): p is ParsedLogFile => p !== null && p.shortId === shortId);
  if (matches.length === 0) return null;

  const phases: CyclePhase[] = [];
  const dumps: CycleDetail["dumps"] = [];
  matches.sort((a, b) => a.startedAt - b.startedAt);
  for (const m of matches) {
    const fullPath = path.join(logsDir, m.filename);
    if (m.isNdjson) {
      const events: Record<string, unknown>[] = [];
      const text = readIfExists(fullPath) ?? "";
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // ignore malformed
        }
      }
      phases.push({
        purpose: m.purpose,
        filename: m.filename,
        started_at: m.startedAt,
        events,
      });
    } else {
      dumps.push({
        phase: m.purpose,
        name: m.dumpName ?? "dump",
        filename: m.filename,
        content: readJsonIfExists(fullPath),
      });
    }
  }
  return {
    short_id: shortId,
    started_at: phases[0]?.started_at ?? matches[0]?.startedAt ?? 0,
    phases,
    dumps,
  };
}

// ─── Session/log helpers ────────────────────────────────────────────────

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJsonIfExists(p: string): unknown | null {
  const text = readIfExists(p);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read bytes appended past `offset`. Returns the new text and updated offset. */
function readSinceOffset(p: string, offset: number): { text: string; newOffset: number } {
  try {
    const stat = fs.statSync(p);
    if (stat.size <= offset) return { text: "", newOffset: offset };
    const fd = fs.openSync(p, "r");
    try {
      const length = stat.size - offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return { text: buf.toString("utf8"), newOffset: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: "", newOffset: offset };
  }
}

function listWorkspaceFiles(dir: string): { name: string; size: number }[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const stat = safeStat(path.join(dir, d.name));
        return { name: d.name, size: stat?.size ?? 0 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

// ─── Introspect helpers ─────────────────────────────────────────────────

function parseSinceMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^(\d+)\s*([smhd])$/);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2];
  const ms =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return Date.now() - n * ms;
}

// ─── Export + artifacts helpers ─────────────────────────────────────────

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024; // 4 MB cap per file fetch

interface ArtifactGroup {
  id: string;
  label: string;
  root: string;
  files: { path: string; size: number; mtime: number }[];
}

const TRANSIENT_BRIEF_FILES = new Set([
  "CURRENT_LEAF.md",
  "WORK_CONTEXT.md",
  "RESULT_SCHEMA.md",
  "TRELLIS_OPS.md",
  "progress.json",
  "result.json",
  "envelope.json",
]);

function collectArtifactGroups(deps: AppDeps): ArtifactGroup[] {
  const groups: ArtifactGroup[] = [];

  // Workspace .trellis/ — where prod-mode Trellis-driven leaves write
  // deliverables that survive across sessions (briefs are overwritten,
  // but the agent's own files accumulate).
  const wsTrellis = path.join(deps.agentWorkspaceDir, ".trellis");
  if (fs.existsSync(wsTrellis)) {
    const files = listArtifactFiles(wsTrellis, "");
    if (files.length > 0) {
      groups.push({
        id: "workspace",
        label: "Workspace .trellis/",
        root: wsTrellis,
        files,
      });
    }
  }

  // Per-session sandboxes under sessionsDir.
  if (fs.existsSync(deps.sessionsDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(deps.sessionsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionRoot = path.join(deps.sessionsDir, ent.name);
      const files = listArtifactFiles(sessionRoot, "");
      if (files.length === 0) continue;
      groups.push({
        id: `session:${ent.name}`,
        label: `Session ${ent.name.slice(0, 8)}`,
        root: sessionRoot,
        files,
      });
    }
    // Sort sessions by most-recent file mtime, descending.
    groups.sort((a, b) => {
      if (a.id === "workspace") return -1;
      if (b.id === "workspace") return 1;
      const am = Math.max(0, ...a.files.map((f) => f.mtime));
      const bm = Math.max(0, ...b.files.map((f) => f.mtime));
      return bm - am;
    });
  }

  return groups;
}

function listArtifactFiles(
  root: string,
  prefix: string,
): { path: string; size: number; mtime: number }[] {
  const out: { path: string; size: number; mtime: number }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const rel = prefix ? path.join(prefix, ent.name) : ent.name;
    if (ent.isDirectory()) {
      // One level of recursion is enough for our shapes.
      if (!prefix) out.push(...listArtifactFiles(root, rel));
      continue;
    }
    if (!ent.isFile()) continue;
    if (TRANSIENT_BRIEF_FILES.has(ent.name)) continue;
    // Only surface human-readable formats. Other files (.png, .pdf, etc.)
    // are noted but not shown.
    if (!/\.(md|txt|json|csv|tsv|ya?ml|js|ts|py|sh|sql)$/i.test(ent.name))
      continue;
    const stat = safeStat(path.join(root, rel));
    if (!stat) continue;
    out.push({ path: rel, size: stat.size, mtime: stat.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function renderGraphAsMarkdown(nodes: Node[], edges: Edge[]): string {
  const byId = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>(); // parent id → child ids
  const otherOut = new Map<string, Edge[]>(); // node id → non-subtask outgoing
  for (const e of edges) {
    if (e.type === "subtask_of") {
      // from is child, to is parent
      const arr = childrenOf.get(e.to_id) ?? [];
      arr.push(e.from_id);
      childrenOf.set(e.to_id, arr);
    } else {
      const arr = otherOut.get(e.from_id) ?? [];
      arr.push(e);
      otherOut.set(e.from_id, arr);
    }
  }
  // Stable child ordering: by priority desc, then created_at asc.
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => {
      const na = byId.get(a);
      const nb = byId.get(b);
      if (!na || !nb) return 0;
      if (nb.priority !== na.priority) return nb.priority - na.priority;
      return na.created_at - nb.created_at;
    });
  }

  const lines: string[] = [];
  lines.push("# Trellis graph export");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Counts: ${nodes.length} nodes, ${edges.length} edges`);
  lines.push("");

  const visited = new Set<string>();

  // Roots first: root_purpose nodes, then any task with no subtask_of parent.
  const roots = nodes
    .filter(
      (n) =>
        n.type === "root_purpose" ||
        (n.type === "task" &&
          !edges.some((e) => e.type === "subtask_of" && e.from_id === n.id)),
    )
    .sort((a, b) => {
      // root_purpose first, then by priority.
      if (a.type !== b.type) return a.type === "root_purpose" ? -1 : 1;
      return b.priority - a.priority;
    });

  for (const r of roots) {
    renderSubtree(r, 1);
  }

  // Append any orphaned/standalone nodes (concepts, entities, notes that
  // weren't reachable from a root) so the export is complete.
  const orphans = nodes.filter((n) => !visited.has(n.id));
  if (orphans.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## (Unrooted nodes)");
    lines.push("");
    for (const o of orphans) {
      renderNodeBlock(o, 3);
    }
  }

  return lines.join("\n");

  function renderSubtree(node: Node, depth: number): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    renderNodeBlock(node, depth);
    const kids = childrenOf.get(node.id) ?? [];
    for (const kid of kids) {
      const kn = byId.get(kid);
      if (kn) renderSubtree(kn, depth + 1);
    }
  }

  function renderNodeBlock(node: Node, depth: number): void {
    const heading = "#".repeat(Math.min(6, Math.max(1, depth)));
    const shortId = node.id.slice(0, 8);
    const tag = `[${node.type} · ${node.status} · ${shortId}]`;
    lines.push(`${heading} ${node.title}`);
    lines.push(tag);
    lines.push("");
    if (node.body && node.body.trim()) {
      lines.push(node.body.trim());
      lines.push("");
    }
    const xrefs = otherOut.get(node.id) ?? [];
    if (xrefs.length > 0) {
      lines.push("Cross-refs:");
      for (const e of xrefs) {
        const target = byId.get(e.to_id);
        const targetTitle = target ? target.title : "(unknown)";
        const targetShort = e.to_id.slice(0, 8);
        lines.push(`- ${e.type} → ${targetShort} ${targetTitle}`);
      }
      lines.push("");
    }
  }
}

function nodesToEdges(deps: AppDeps, _nodes: Node[]): Edge[] {
  // Naive but fine for the v1 graph sizes we deal with: pull every edge
  // by querying each node's outbound edges and dedupe by id.
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const n of _nodes) {
    for (const e of deps.repo.edgesFrom(n.id)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      edges.push(e);
    }
  }
  return edges;
}
