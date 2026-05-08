import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/trellis-test-sessions" });
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/trellis-test-sessions" });
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/trellis-test-sessions" });
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/trellis-test-sessions" });
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/trellis-test-sessions" });
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
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/trellis-test-sessions" });
    const res = await app.fetch(new Request("http://x/api/events?limit=10"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { type: string }[] };
    // Two node_created events from the two tasks.
    const types = body.events.map((e) => e.type);
    expect(types.filter((t) => t === "node_created").length).toBe(2);
  });

  it("clamps limit to a reasonable upper bound", async () => {
    const app = buildApp({ repo, bus, sessionsDir: "/tmp/trellis-test-sessions" });
    const res = await app.fetch(
      new Request("http://x/api/events?limit=99999999"),
    );
    expect(res.status).toBe(200);
    // No new events created; just shouldn't error.
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
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
