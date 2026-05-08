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

    const app = buildApp({ repo, bus, sessionsDir: "/tmp/x", logsDir });
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/x", logsDir });
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/x", logsDir });
    const res = await app.fetch(new Request("http://x/api/cycles/00000000"));
    expect(res.status).toBe(404);
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
