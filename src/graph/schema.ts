import { z } from "zod";

export const NODE_TYPES = [
  "task",
  "note",
  "memory",
  "concept",
  "entity",
  "timeframe",
  "rationale",
  "strategy",
  "root_purpose",
  "risk",
  "scenario",
  "outcome",
  "research",
  "session",
] as const;

export const NodeType = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeType>;

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
  "n/a",
] as const;

export const NodeStatus = z.enum(TASK_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const TASK_KINDS = ["oneoff", "recurring", "continuous"] as const;
export const TaskKind = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKind>;

export const EDGE_TYPES = [
  "subtask_of",
  "depends_on",
  "rationale_for",
  "ladders_up_to",
  "contingent_on",
  "risk_of",
  "outcome_of",
  "mentions",
  "relates_to",
  "duplicate_of",
  "derives_from",
  "supersedes",
  "produced_in_session",
] as const;

export const EdgeType = z.enum(EDGE_TYPES);
export type EdgeType = z.infer<typeof EdgeType>;

export const Node = z.object({
  id: z.string().uuid(),
  type: NodeType,
  title: z.string().min(1),
  body: z.string().default(""),
  status: NodeStatus.default("n/a"),
  task_kind: TaskKind.nullable().default(null),
  priority: z.number().min(0).max(1).default(0.5),
  schedule: z.string().nullable().default(null),
  due_at: z.number().int().nullable().default(null),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  last_touched_at: z.number().int(),
  completed_at: z.number().int().nullable().default(null),
  /** When the agent last investigated this leaf and produced a verdict.
   *  Distinct from last_touched_at: this is set only by execute, not by
   *  arbitrary edits or events. Used by the agent scheduler to prefer
   *  never-verified or stale-verified leaves. */
  verified_at: z.number().int().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
  revision: z.number().int().default(1),
});
export type Node = z.infer<typeof Node>;

export const NewNode = Node.omit({
  id: true,
  created_at: true,
  updated_at: true,
  last_touched_at: true,
  completed_at: true,
  verified_at: true,
  revision: true,
}).extend({
  id: z.string().uuid().optional(),
});
export type NewNode = z.infer<typeof NewNode>;

export const Edge = z.object({
  id: z.string().uuid(),
  from_id: z.string().uuid(),
  to_id: z.string().uuid(),
  type: EdgeType,
  weight: z.number().min(0).max(1).default(1),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.number().int(),
});
export type Edge = z.infer<typeof Edge>;

export const NewEdge = Edge.omit({
  id: true,
  created_at: true,
}).extend({
  id: z.string().uuid().optional(),
});
export type NewEdge = z.infer<typeof NewEdge>;

export const EVENT_TYPES = [
  "node_created",
  "node_updated",
  "node_archived",
  "edge_created",
  "edge_removed",
  "cycle_started",
  "cycle_phase_completed",
  "cycle_completed",
  "dedupe_decision",
  "session_started",
  "session_ended",
  "dream_started",
  "dream_proposal",
  "dream_applied",
  "llm_call",
] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const Event = z.object({
  id: z.string().uuid(),
  type: EventType,
  node_id: z.string().uuid().nullable().default(null),
  edge_id: z.string().uuid().nullable().default(null),
  payload: z.record(z.unknown()).default({}),
  created_at: z.number().int(),
});
export type Event = z.infer<typeof Event>;

export const Session = z.object({
  id: z.string().uuid(),
  task_node_id: z.string().uuid(),
  workspace_path: z.string(),
  transcript_path: z.string().nullable(),
  status: z.enum(["running", "completed", "failed"]),
  tool_calls: z.number().int().default(0),
  started_at: z.number().int(),
  ended_at: z.number().int().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});
export type Session = z.infer<typeof Session>;

export type NodeRow = Omit<Node, "metadata"> & { metadata: string };
export type EdgeRow = Omit<Edge, "metadata"> & { metadata: string };
export type EventRow = Omit<Event, "payload"> & { payload: string };
export type SessionRow = Omit<Session, "metadata"> & { metadata: string };
