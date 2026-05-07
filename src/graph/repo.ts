import type { Database as DB } from "better-sqlite3";
import { v4 as uuid } from "uuid";
import {
  Node,
  NewNode,
  Edge,
  NewEdge,
  Event,
  EventType,
  NodeType,
  NodeStatus,
  EdgeType,
  type NodeRow,
  type EdgeRow,
  type EventRow,
} from "./schema.js";

const now = (): number => Date.now();

function rowToNode(r: NodeRow): Node {
  return {
    ...r,
    metadata: JSON.parse(r.metadata as unknown as string) as Record<
      string,
      unknown
    >,
  };
}

function rowToEdge(r: EdgeRow): Edge {
  return {
    ...r,
    metadata: JSON.parse(r.metadata as unknown as string) as Record<
      string,
      unknown
    >,
  };
}

function rowToEvent(r: EventRow): Event {
  return {
    ...r,
    payload: JSON.parse(r.payload as unknown as string) as Record<
      string,
      unknown
    >,
  };
}

export class Repo {
  constructor(private readonly db: DB) {}

  // ---------- nodes ----------

  createNode(input: NewNode): Node {
    const parsed = NewNode.parse(input);
    const ts = now();
    const node: Node = {
      id: parsed.id ?? uuid(),
      type: parsed.type,
      title: parsed.title,
      body: parsed.body,
      status: parsed.status,
      task_kind: parsed.task_kind,
      priority: parsed.priority,
      schedule: parsed.schedule,
      due_at: parsed.due_at,
      created_at: ts,
      updated_at: ts,
      last_touched_at: ts,
      completed_at: null,
      metadata: parsed.metadata,
      revision: 1,
    };
    this.db
      .prepare(
        `INSERT INTO nodes (id,type,title,body,status,task_kind,priority,schedule,due_at,
          created_at,updated_at,last_touched_at,completed_at,metadata,revision)
          VALUES (@id,@type,@title,@body,@status,@task_kind,@priority,@schedule,@due_at,
          @created_at,@updated_at,@last_touched_at,@completed_at,@metadata,@revision)`,
      )
      .run({ ...node, metadata: JSON.stringify(node.metadata) });
    this.recordEvent({
      type: "node_created",
      node_id: node.id,
      payload: { type: node.type, title: node.title },
    });
    return node;
  }

  getNode(id: string): Node | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  updateNode(
    id: string,
    patch: Partial<
      Pick<
        Node,
        | "title"
        | "body"
        | "status"
        | "task_kind"
        | "priority"
        | "schedule"
        | "due_at"
        | "completed_at"
        | "metadata"
      >
    >,
  ): Node {
    const existing = this.getNode(id);
    if (!existing) throw new Error(`node ${id} not found`);
    const next: Node = {
      ...existing,
      ...patch,
      metadata: { ...existing.metadata, ...(patch.metadata ?? {}) },
      updated_at: now(),
      last_touched_at: now(),
      revision: existing.revision + 1,
    };
    if (patch.status === "done" && !existing.completed_at) {
      next.completed_at = now();
    }
    this.db
      .prepare(
        `UPDATE nodes
         SET title=@title,body=@body,status=@status,task_kind=@task_kind,priority=@priority,
             schedule=@schedule,due_at=@due_at,completed_at=@completed_at,
             updated_at=@updated_at,last_touched_at=@last_touched_at,
             metadata=@metadata,revision=@revision
         WHERE id=@id`,
      )
      .run({ ...next, metadata: JSON.stringify(next.metadata) });
    this.recordEvent({
      type: "node_updated",
      node_id: id,
      payload: { patch: Object.keys(patch) },
    });
    return next;
  }

  touchNode(id: string): void {
    this.db
      .prepare("UPDATE nodes SET last_touched_at = ? WHERE id = ?")
      .run(now(), id);
  }

  listNodes(filter?: {
    type?: NodeType;
    status?: NodeStatus;
    limit?: number;
  }): Node[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.type) {
      where.push("type = @type");
      params.type = filter.type;
    }
    if (filter?.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    const sql = `SELECT * FROM nodes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY last_touched_at DESC ${filter?.limit ? "LIMIT " + Math.max(1, filter.limit | 0) : ""}`;
    return (this.db.prepare(sql).all(params) as NodeRow[]).map(rowToNode);
  }

  // ---------- edges ----------

  addEdge(input: NewEdge): Edge {
    const parsed = NewEdge.parse(input);
    const ts = now();
    const edge: Edge = {
      id: parsed.id ?? uuid(),
      from_id: parsed.from_id,
      to_id: parsed.to_id,
      type: parsed.type,
      weight: parsed.weight,
      metadata: parsed.metadata,
      created_at: ts,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO edges (id,from_id,to_id,type,weight,metadata,created_at)
           VALUES (@id,@from_id,@to_id,@type,@weight,@metadata,@created_at)`,
        )
        .run({ ...edge, metadata: JSON.stringify(edge.metadata) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) {
        const existing = this.db
          .prepare(
            "SELECT * FROM edges WHERE from_id=? AND to_id=? AND type=?",
          )
          .get(edge.from_id, edge.to_id, edge.type) as EdgeRow;
        return rowToEdge(existing);
      }
      throw e;
    }
    this.recordEvent({
      type: "edge_created",
      node_id: edge.from_id,
      edge_id: edge.id,
      payload: { type: edge.type, to: edge.to_id },
    });
    return edge;
  }

  removeEdge(id: string): void {
    this.db.prepare("DELETE FROM edges WHERE id = ?").run(id);
    this.recordEvent({ type: "edge_removed", edge_id: id });
  }

  edgesFrom(nodeId: string, type?: EdgeType): Edge[] {
    const rows = type
      ? (this.db
          .prepare("SELECT * FROM edges WHERE from_id = ? AND type = ?")
          .all(nodeId, type) as EdgeRow[])
      : (this.db
          .prepare("SELECT * FROM edges WHERE from_id = ?")
          .all(nodeId) as EdgeRow[]);
    return rows.map(rowToEdge);
  }

  edgesTo(nodeId: string, type?: EdgeType): Edge[] {
    const rows = type
      ? (this.db
          .prepare("SELECT * FROM edges WHERE to_id = ? AND type = ?")
          .all(nodeId, type) as EdgeRow[])
      : (this.db
          .prepare("SELECT * FROM edges WHERE to_id = ?")
          .all(nodeId) as EdgeRow[]);
    return rows.map(rowToEdge);
  }

  /**
   * Redirect every edge that references `fromId` to reference `toId` instead,
   * in either direction. Used by dedupe to merge a duplicate node into its
   * canonical counterpart. Self-loops produced by the rewrite are deleted.
   * Returns the number of edges updated and the number of self-loops removed.
   */
  redirectEdgeRefs(fromId: string, toId: string): {
    rewrittenFrom: number;
    rewrittenTo: number;
    selfLoopsRemoved: number;
  } {
    if (fromId === toId) {
      return { rewrittenFrom: 0, rewrittenTo: 0, selfLoopsRemoved: 0 };
    }
    let rewrittenFrom = 0;
    let rewrittenTo = 0;
    let selfLoopsRemoved = 0;
    this.tx(() => {
      // Outgoing: from_id == fromId.
      const outs = this.db
        .prepare("SELECT * FROM edges WHERE from_id = ?")
        .all(fromId) as EdgeRow[];
      for (const e of outs) {
        if (e.to_id === toId) {
          // Would become a self-loop; delete instead.
          this.db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
          selfLoopsRemoved++;
          continue;
        }
        try {
          this.db
            .prepare("UPDATE edges SET from_id = ? WHERE id = ?")
            .run(toId, e.id);
          rewrittenFrom++;
        } catch (err: unknown) {
          // UNIQUE collision (from_id, to_id, type) means an equivalent edge
          // already exists on the canonical node. Drop the redundant one.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("UNIQUE")) {
            this.db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
          } else {
            throw err;
          }
        }
      }
      // Incoming: to_id == fromId.
      const ins = this.db
        .prepare("SELECT * FROM edges WHERE to_id = ?")
        .all(fromId) as EdgeRow[];
      for (const e of ins) {
        if (e.from_id === toId) {
          this.db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
          selfLoopsRemoved++;
          continue;
        }
        try {
          this.db
            .prepare("UPDATE edges SET to_id = ? WHERE id = ?")
            .run(toId, e.id);
          rewrittenTo++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("UNIQUE")) {
            this.db.prepare("DELETE FROM edges WHERE id = ?").run(e.id);
          } else {
            throw err;
          }
        }
      }
    });
    return { rewrittenFrom, rewrittenTo, selfLoopsRemoved };
  }

  /** Delete a node and (via cascade) its edges. Idempotent. */
  deleteNode(id: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    this.recordEvent({
      type: "node_archived",
      node_id: id,
      payload: { reason: "delete" },
    });
  }

  // ---------- events ----------

  recordEvent(input: {
    type: EventType;
    node_id?: string | null;
    edge_id?: string | null;
    payload?: Record<string, unknown>;
  }): Event {
    const ev: Event = {
      id: uuid(),
      type: input.type,
      node_id: input.node_id ?? null,
      edge_id: input.edge_id ?? null,
      payload: input.payload ?? {},
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO events (id,type,node_id,edge_id,payload,created_at)
         VALUES (@id,@type,@node_id,@edge_id,@payload,@created_at)`,
      )
      .run({ ...ev, payload: JSON.stringify(ev.payload) });
    return ev;
  }

  recentEvents(limit = 100): Event[] {
    return (
      this.db
        .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, limit | 0)) as EventRow[]
    ).map(rowToEvent);
  }

  // ---------- transactions ----------

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
