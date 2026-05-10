import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import { EventBus } from "../src/server/events.js";
import { buildApp } from "../src/server/routes.js";

let db: DB;
let repo: Repo;
let bus: EventBus;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
  bus = new EventBus(repo);
});

afterEach(() => {
  bus.stop();
  close(db);
});

function task(title: string) {
  return repo.createNode({
    type: "task",
    title,
    body: `body for ${title}`,
    status: "open",
    task_kind: "oneoff",
    priority: 0.5,
    schedule: null,
    due_at: null,
    metadata: {},
  });
}

describe("/api/health", () => {
  it("returns ok=true", async () => {
    const app = buildApp({
    repo,
    bus,
    sessionsDir: "/tmp/trellis-test-sessions",
    logsDir: "/tmp/trellis-test-logs",
  });
    const res = await app.fetch(new Request("http://x/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("/api/graph", () => {
  it("returns nodes and edges with counts", async () => {
    const a = task("alpha");
    const b = task("beta");
    repo.addEdge({
      from_id: b.id,
      to_id: a.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    const app = buildApp({
    repo,
    bus,
    sessionsDir: "/tmp/trellis-test-sessions",
    logsDir: "/tmp/trellis-test-logs",
  });
    const res = await app.fetch(new Request("http://x/api/graph"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: { id: string }[];
      edges: { id: string }[];
      counts: { nodes: number; edges: number };
    };
    expect(body.counts.nodes).toBe(2);
    expect(body.counts.edges).toBe(1);
    expect(body.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("empty graph returns empty arrays", async () => {
    const app = buildApp({
    repo,
    bus,
    sessionsDir: "/tmp/trellis-test-sessions",
    logsDir: "/tmp/trellis-test-logs",
  });
    const res = await app.fetch(new Request("http://x/api/graph"));
    const body = (await res.json()) as { counts: { nodes: number; edges: number } };
    expect(body.counts.nodes).toBe(0);
    expect(body.counts.edges).toBe(0);
  });
});

describe("/api/nodes/:id", () => {
  it("returns node with incoming and outgoing edges", async () => {
    const parent = task("parent");
    const child = task("child");
    const sibling = task("sibling");
    repo.addEdge({
      from_id: child.id,
      to_id: parent.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
    repo.addEdge({
      from_id: sibling.id,
      to_id: parent.id,
      type: "subtask_of",
      weight: 0.5,
      metadata: {},
    });
    const app = buildApp({
    repo,
    bus,
    sessionsDir: "/tmp/trellis-test-sessions",
    logsDir: "/tmp/trellis-test-logs",
  });
    const res = await app.fetch(new Request(`http://x/api/nodes/${parent.id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      node: { id: string; title: string };
      edges: { incoming: { from_id: string }[]; outgoing: unknown[] };
    };
    expect(body.node.id).toBe(parent.id);
    expect(body.edges.incoming).toHaveLength(2);
    expect(body.edges.outgoing).toHaveLength(0);
  });

  it("404s on unknown id", async () => {
    const app = buildApp({
    repo,
    bus,
    sessionsDir: "/tmp/trellis-test-sessions",
    logsDir: "/tmp/trellis-test-logs",
  });
    const res = await app.fetch(
      new Request("http://x/api/nodes/00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });
});

describe("/api/events", () => {
  it("returns recent events ordered desc", async () => {
    task("a");
    task("b");
    const app = buildApp({
    repo,
    bus,
    sessionsDir: "/tmp/trellis-test-sessions",
    logsDir: "/tmp/trellis-test-logs",
  });
    const res = await app.fetch(new Request("http://x/api/events?limit=10"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { type: string }[] };
    // Two node_created events from the two tasks.
    const types = body.events.map((e) => e.type);
    expect(types.filter((t) => t === "node_created").length).toBe(2);
  });

  it("clamps limit to a reasonable upper bound", async () => {
    const app = buildApp({
    repo,
    bus,
    sessionsDir: "/tmp/trellis-test-sessions",
    logsDir: "/tmp/trellis-test-logs",
  });
    const res = await app.fetch(
      new Request("http://x/api/events?limit=99999999"),
    );
    expect(res.status).toBe(200);
    // No new events created; just shouldn't error.
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});

describe("/api/cycles", () => {
  let logsDir = "";
  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-cycles-test-"));
  });
  afterEach(() => {
    if (logsDir) fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it("lists cycles aggregated by short id", async () => {
    fs.writeFileSync(
      path.join(logsDir, "2026-05-08T10-00-00-000Z__extrapolate__abcd1234.ndjson"),
      '{"t":1,"kind":"hello"}\n{"t":2,"kind":"world"}\n',
    );
    fs.writeFileSync(
      path.join(logsDir, "2026-05-08T10-01-00-000Z__index__abcd1234.ndjson"),
      '{"t":3,"kind":"index_done"}\n',
    );
    fs.writeFileSync(
      path.join(logsDir, "2026-05-08T10-00-30-000Z__extrapolate__abcd1234__tool_use_input.json"),
      '{"foo":"bar"}',
    );
    fs.writeFileSync(
      path.join(logsDir, "2026-05-08T11-00-00-000Z__loop__deadbeef.ndjson"),
      '{"t":1,"kind":"loop_started"}\n',
    );

    const app = buildApp({ repo, bus, sessionsDir: "/tmp/x", logsDir, agentWorkspaceDir: "/tmp/y" });
    const res = await app.fetch(new Request("http://x/api/cycles"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cycles: { short_id: string; purposes: string[] }[];
    };
    expect(body.cycles).toHaveLength(2);
    expect(body.cycles[0]!.short_id).toBe("deadbeef");
    expect(body.cycles[1]!.short_id).toBe("abcd1234");
    expect(body.cycles[1]!.purposes.sort()).toEqual(["extrapolate", "index"]);
  });

  it("returns parsed events + dumps for a single cycle", async () => {
    fs.writeFileSync(
      path.join(logsDir, "2026-05-08T10-00-00-000Z__extrapolate__abcd1234.ndjson"),
      '{"t":1,"kind":"a"}\n{"t":2,"kind":"b"}\n',
    );
    fs.writeFileSync(
      path.join(logsDir, "2026-05-08T10-00-30-000Z__extrapolate__abcd1234__dump.json"),
      '{"foo":"bar"}',
    );
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/x", logsDir, agentWorkspaceDir: "/tmp/y" });
    const res = await app.fetch(new Request("http://x/api/cycles/abcd1234"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      short_id: string;
      phases: { events: unknown[] }[];
      dumps: { name: string; content: unknown }[];
    };
    expect(body.short_id).toBe("abcd1234");
    expect(body.phases).toHaveLength(1);
    expect(body.phases[0]!.events).toHaveLength(2);
    expect(body.dumps).toHaveLength(1);
    expect(body.dumps[0]!.content).toEqual({ foo: "bar" });
  });

  it("404s on unknown cycle id", async () => {
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/x", logsDir, agentWorkspaceDir: "/tmp/y" });
    const res = await app.fetch(new Request("http://x/api/cycles/00000000"));
    expect(res.status).toBe(404);
  });
});

describe("/api/export/text", () => {
  it("renders the graph as a hierarchical markdown doc", async () => {
    const root = repo.createNode({
      type: "root_purpose",
      title: "Win at startups",
      body: "Find a wedge.",
      status: "open",
      task_kind: "continuous",
      priority: 1,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    const child = repo.createNode({
      type: "task",
      title: "Build a longlist",
      body: "27 ideas across 13 verticals.",
      status: "done",
      task_kind: "oneoff",
      priority: 0.8,
      schedule: null,
      due_at: null,
      metadata: {},
    });
    repo.addEdge({
      from_id: child.id,
      to_id: root.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });

    const app = buildApp({
      repo,
      bus,
      sessionsDir: "/tmp/x",
      logsDir: "/tmp/y",
      agentWorkspaceDir: "/tmp/z",
    });
    const res = await app.fetch(new Request("http://x/api/export/text"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/markdown/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);
    const text = await res.text();
    expect(text).toMatch(/^# Trellis graph export/m);
    expect(text).toMatch(/Counts: 2 nodes, 1 edges/);
    // Root rendered as H2 (depth=1 → 2 #s? actually depth 1 → 1 #).
    // We chose depth 1 → "#", so root_purpose appears as H1 inside the doc.
    expect(text).toMatch(/# Win at startups/);
    expect(text).toMatch(/Find a wedge\./);
    // Child indented one level deeper.
    expect(text).toMatch(/## Build a longlist/);
    expect(text).toMatch(/27 ideas across 13 verticals\./);
    // Tag line includes type/status/short id.
    expect(text).toMatch(/\[task · done · [0-9a-f]{8}\]/);
  });
});

describe("/api/artifacts", () => {
  let workspaceDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-test-ws-"));
    sessionsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "trellis-test-sessions-"),
    );
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("groups workspace .trellis/ artifacts and per-session ones, hides briefs", async () => {
    // Workspace .trellis/ with one real artifact + one transient brief
    fs.mkdirSync(path.join(workspaceDir, ".trellis"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".trellis", "mvp_spec.md"),
      "# MVP",
    );
    fs.writeFileSync(
      path.join(workspaceDir, ".trellis", "CURRENT_LEAF.md"),
      "transient",
    );
    fs.writeFileSync(
      path.join(workspaceDir, ".trellis", "result.json"),
      "{}",
    );
    // Per-session sandbox
    const sId = "12345678-1234-1234-1234-123456789012";
    fs.mkdirSync(path.join(sessionsDir, sId), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, sId, "openclaw.stdout.log"),
      "log",
    );
    fs.writeFileSync(
      path.join(sessionsDir, sId, "longlist.csv"),
      "a,b,c\n",
    );

    const app = buildApp({
      repo,
      bus,
      sessionsDir,
      logsDir: "/tmp/xlogs",
      agentWorkspaceDir: workspaceDir,
    });

    const res = await app.fetch(new Request("http://x/api/artifacts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: { id: string; label: string; files: { path: string }[] }[];
    };
    const ws = body.groups.find((g) => g.id === "workspace");
    expect(ws).toBeTruthy();
    const wsPaths = ws!.files.map((f) => f.path);
    expect(wsPaths).toContain("mvp_spec.md");
    expect(wsPaths).not.toContain("CURRENT_LEAF.md");
    expect(wsPaths).not.toContain("result.json");

    const session = body.groups.find((g) => g.id === `session:${sId}`);
    expect(session).toBeTruthy();
    expect(session!.files.map((f) => f.path)).toContain("longlist.csv");
    // .log files are not in the human-readable allowlist
    expect(session!.files.map((f) => f.path)).not.toContain(
      "openclaw.stdout.log",
    );
  });

  it("returns file content with /api/artifacts/file", async () => {
    fs.mkdirSync(path.join(workspaceDir, ".trellis"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".trellis", "mvp_spec.md"),
      "# Spec\nbody here",
    );
    const app = buildApp({
      repo,
      bus,
      sessionsDir,
      logsDir: "/tmp/xlogs",
      agentWorkspaceDir: workspaceDir,
    });
    const res = await app.fetch(
      new Request(
        "http://x/api/artifacts/file?group=workspace&path=mvp_spec.md",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      path: string;
      size: number;
    };
    expect(body.content).toBe("# Spec\nbody here");
    expect(body.path).toBe("mvp_spec.md");
    expect(body.size).toBe(Buffer.byteLength("# Spec\nbody here", "utf8"));
  });

  it("rejects path traversal", async () => {
    fs.mkdirSync(path.join(workspaceDir, ".trellis"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".trellis", "real.md"),
      "ok",
    );
    const app = buildApp({
      repo,
      bus,
      sessionsDir,
      logsDir: "/tmp/xlogs",
      agentWorkspaceDir: workspaceDir,
    });
    const res = await app.fetch(
      new Request(
        "http://x/api/artifacts/file?group=workspace&path=../../../../etc/passwd",
      ),
    );
    expect([400, 404]).toContain(res.status);
  });
});

describe("/api/human-queue", () => {
  it("lists human_blocked tasks with metadata fields surfaced", async () => {
    const t = task("needs nathan");
    repo.updateNode(t.id, {
      status: "human_blocked",
      metadata: {
        human_blocker: "needs Nathan to choose between Stripe and Adyen",
        flagged_at: 1_700_000_000_000,
        flagged_by: "review_human_blocked",
      },
    });
    // Add a non-human-blocked task that should NOT show up.
    task("normal");

    const app = buildApp({
      repo,
      bus,
      sessionsDir: "/tmp/x",
      logsDir: "/tmp/y",
      agentWorkspaceDir: "/tmp/z",
    });
    const res = await app.fetch(new Request("http://x/api/human-queue"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; title: string; human_blocker: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.title).toBe("needs nathan");
    expect(body.items[0]!.human_blocker).toMatch(/Stripe and Adyen/);
  });

  it("rejects resolve on a non-human_blocked node", async () => {
    const t = task("normal");
    const app = buildApp({
      repo,
      bus,
      sessionsDir: "/tmp/x",
      logsDir: "/tmp/y",
      agentWorkspaceDir: "/tmp/z",
    });
    const res = await app.fetch(
      new Request(`http://x/api/human-queue/${t.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("resolve flips status, captures response in metadata + body", async () => {
    const t = task("needs nathan");
    repo.updateNode(t.id, {
      status: "human_blocked",
      metadata: { human_blocker: "x" },
    });
    const app = buildApp({
      repo,
      bus,
      sessionsDir: "/tmp/x",
      logsDir: "/tmp/y",
      agentWorkspaceDir: "/tmp/z",
    });
    const res = await app.fetch(
      new Request(`http://x/api/human-queue/${t.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "use Stripe.", status: "done" }),
      }),
    );
    expect(res.status).toBe(200);
    const node = repo.getNode(t.id);
    expect(node?.status).toBe("done");
    expect(node?.body).toMatch(/Resolution from Nathan/);
    expect(node?.body).toMatch(/use Stripe\./);
    expect((node?.metadata as Record<string, unknown>).human_response).toBe(
      "use Stripe.",
    );
  });

  it("resolve --status=open re-opens the task with the response baked in", async () => {
    const t = task("needs nathan");
    repo.updateNode(t.id, {
      status: "human_blocked",
      metadata: { human_blocker: "x" },
    });
    const app = buildApp({
      repo,
      bus,
      sessionsDir: "/tmp/x",
      logsDir: "/tmp/y",
      agentWorkspaceDir: "/tmp/z",
    });
    const res = await app.fetch(
      new Request(`http://x/api/human-queue/${t.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: "the answer is 42, retry now",
          status: "open",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(repo.getNode(t.id)?.status).toBe("open");
  });
});

describe("/api/usage", () => {
  it("aggregates llm_call events by model + purpose, returns totals", async () => {
    const t = task("x");
    // Record a few synthetic llm_call events.
    repo.recordEvent({
      type: "llm_call",
      node_id: t.id,
      payload: {
        model: "claude-opus-4-7",
        purpose: "extrapolate",
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        usd_estimated: 0.0525,
        duration_ms: 12_000,
      },
    });
    repo.recordEvent({
      type: "llm_call",
      node_id: null,
      payload: {
        model: "claude-sonnet-4-6",
        purpose: "scheduler_decide",
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        usd_estimated: 0.003,
        duration_ms: 1_500,
      },
    });
    const app = buildApp({
      repo,
      bus,
      sessionsDir: "/tmp/x",
      logsDir: "/tmp/y",
      agentWorkspaceDir: "/tmp/z",
    });
    const res = await app.fetch(new Request("http://x/api/usage"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_calls: number;
      total_usd: number;
      tokens: { input: number; output: number };
      by_model: Record<string, { calls: number; usd: number }>;
      by_purpose: Record<string, { calls: number; usd: number }>;
      recent: { model: string; purpose: string }[];
    };
    expect(body.total_calls).toBe(2);
    expect(body.total_usd).toBeCloseTo(0.06, 2);
    expect(body.tokens.input).toBe(1500);
    expect(body.tokens.output).toBe(600);
    expect(body.by_model["claude-opus-4-7"]?.calls).toBe(1);
    expect(body.by_purpose.extrapolate?.calls).toBe(1);
    expect(body.recent).toHaveLength(2);
  });
});

describe("EventBus subscribe + tick", () => {
  it("delivers new events to subscribers", () => {
    const received: string[] = [];
    bus.start();
    bus.subscribe((e) => received.push(e.type));
    task("trigger event");
    bus.tickNow();
    expect(received.includes("node_created")).toBe(true);
  });

  it("does not redeliver previously seen events", () => {
    bus.start();
    task("first");
    bus.tickNow(); // consumes the historical event(s) up to first
    const received: string[] = [];
    bus.subscribe((e) => received.push(e.id));
    bus.tickNow(); // no new events
    expect(received).toHaveLength(0);
    task("second");
    bus.tickNow();
    expect(received).toHaveLength(1);
  });
});
