import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import type { Repo } from "../graph/repo.js";
import type { Edge, Node } from "../graph/schema.js";
import type { EventBus } from "./events.js";

export interface AppDeps {
  repo: Repo;
  bus: EventBus;
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

  /** Recent events. Useful for first-paint of the activity feed; subsequent
   *  updates flow over /api/events/stream. */
  app.get("/api/events", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const events = deps.repo.recentEvents(Math.max(1, Math.min(1000, limit)));
    return c.json({ events });
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
