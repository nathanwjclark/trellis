/**
 * Mirror of the wire types the trellis HTTP API returns. These are kept
 * loose-friendly (string-typed enums) so the UI doesn't break when the
 * backend introduces a new node/edge type before the UI catches up.
 */

export interface ApiNode {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  task_kind: string | null;
  priority: number;
  schedule: string | null;
  due_at: number | null;
  created_at: number;
  updated_at: number;
  last_touched_at: number;
  completed_at: number | null;
  verified_at: number | null;
  revision: number;
  metadata: Record<string, unknown>;
}

export interface ApiEdge {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface ApiEvent {
  id: string;
  type: string;
  node_id: string | null;
  edge_id: string | null;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface GraphResponse {
  nodes: ApiNode[];
  edges: ApiEdge[];
  counts: { nodes: number; edges: number };
}

export interface NodeDetailResponse {
  node: ApiNode;
  edges: { incoming: ApiEdge[]; outgoing: ApiEdge[] };
}

export interface SessionDetail {
  session_id: string;
  workspace_dir: string;
  stdout_size: number;
  stderr_size: number;
  has_result: boolean;
  has_envelope: boolean;
  result: unknown | null;
  files: { name: string; size: number }[];
}

export interface CycleSummary {
  short_id: string;
  started_at: number;
  purposes: string[];
  ndjson_files: number;
  dump_files: number;
}

export interface CyclePhase {
  purpose: string;
  filename: string;
  started_at: number;
  events: Record<string, unknown>[];
}

export interface CycleDump {
  phase: string;
  name: string;
  filename: string;
  content: unknown;
}

export interface CycleDetail {
  short_id: string;
  started_at: number;
  phases: CyclePhase[];
  dumps: CycleDump[];
}
