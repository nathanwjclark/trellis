import fs from "node:fs";
import path from "node:path";
import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";

/**
 * Computes a six-stat introspection report on a Trellis graph + log dir.
 *
 * The goal is to expose "temperature collapse" — the pattern where an
 * agent extrapolates a lot up front, then settles into pure execute-the-
 * critical-path-leaf behavior with no revisiting, no reframing, and no
 * step-back. Each statistic surfaces a different facet of that pattern;
 * none alone is conclusive but the combination paints the trajectory.
 */

export interface IntrospectionReport {
  generated_at: number;
  graph_summary: GraphSummary;
  generative_vs_revision: GenerativeVsRevision;
  axis_balance: AxisBalance;
  knowledge_capital: KnowledgeCapital;
  re_extrapolation: ReExtrapolation;
  lateral_movement: LateralMovement;
  scheduler_rationales: SchedulerRationales;
}

export interface GraphSummary {
  total_nodes: number;
  total_edges: number;
  by_status: Record<string, number>;
  spans_ms: { earliest: number; latest: number };
}

// ─── Stat 1: Generative vs revision ───────────────────────────────────────

export interface GenerativeVsRevision {
  total_creations: number;
  total_updates: number;
  updates_per_node: number;
  revision_histogram: Record<string, number>; // "1", "2", "3", "4+"
  /** Time-binned counts: each bucket = count of node_created vs node_updated
   *  events whose timestamps fall in [bucket.start, bucket.end). */
  time_buckets: TimeBucket[];
}

export interface TimeBucket {
  start: number;
  end: number;
  created: number;
  updated: number;
}

// ─── Stat 2: Per-axis extrapolation balance ──────────────────────────────

export interface AxisBalance {
  /** Edges grouped by their conceptual axis. subtask_of/depends_on go
   *  "down" (decomposition), risk_of/contingent_on/outcome_of go
   *  "forward" (contingency), rationale_for goes "back" (provenance),
   *  ladders_up_to goes "up" (strategy). The rest are "other". */
  axes: Record<AxisKind, AxisRow>;
}

export type AxisKind =
  | "down"
  | "forward"
  | "back"
  | "up"
  | "lateral"
  | "other";

export interface AxisRow {
  count: number;
  fraction: number;
  edge_types: Record<string, number>;
}

// ─── Stat 3: Knowledge capital fraction ──────────────────────────────────

export interface KnowledgeCapital {
  thinking_count: number;
  doing_count: number;
  thinking_fraction: number;
  by_type: Record<string, number>;
  research_followthrough: {
    total: number;
    answered: number; // research nodes with non-empty body
    unanswered: number;
  };
}

const THINKING_TYPES = new Set([
  "concept",
  "research",
  "strategy",
  "rationale",
]);
const DOING_TYPES = new Set([
  "task",
  "note",
  "risk",
  "outcome",
  "scenario",
  "session",
  "memory",
  "entity",
  "timeframe",
  "root_purpose",
]);

// ─── Stat 4: Re-extrapolation rate ───────────────────────────────────────

export interface ReExtrapolation {
  total_extrapolate_calls: number;
  /** Calls whose source_id had been extrapolated before. The cleanest
   *  "let me reconsider this" signal. */
  on_previously_cycled_nodes: number;
  /** Calls on a non-leaf node *after* one of its descendants was
   *  executed. The "I learned something doing the work, now I'm
   *  rethinking the parent" signal. */
  on_parent_after_descendant_executed: number;
  examples: { source_id: string; count: number }[]; // top re-cycled nodes
}

// ─── Stat 5: Lateral movement ─────────────────────────────────────────────

export interface LateralMovement {
  scheduler_picks: number;
  /** Histogram of graph distances from the previous pick. distance=1 is
   *  "next critical-path successor" (exploit). Larger distances mean
   *  the agent jumped to a different branch. */
  distance_histogram: Record<string, number>; // "1", "2", "3", "4", "5+", "disconnected"
  median_distance: number;
  mean_distance: number;
}

// ─── Stat 6: Scheduler rationales ────────────────────────────────────────

export interface SchedulerRationales {
  total_decisions: number;
  classified: {
    exploit: number;
    explore: number;
    neutral: number;
  };
  examples: {
    exploit: string[];
    explore: string[];
    neutral: string[];
  };
}

// Lexical buckets. Deliberately conservative — we'd rather mark
// rationales "neutral" than over-claim that the scheduler is reflecting.
const EXPLOIT_KEYWORDS = [
  "next critical-path",
  "critical path",
  "critical-path",
  "next leaf",
  "next subtask",
  "unblock",
  "highest priority",
  "highest-priority",
  "direct successor",
  "next step",
  "downstream",
];
const EXPLORE_KEYWORDS = [
  "reconsider",
  "step back",
  "re-examine",
  "rethink",
  "different angle",
  "different approach",
  "instead of",
  "rather than",
  "let me",
  "haven't tried",
  "haven't explored",
  "underexplored",
  "missing",
  "gap in",
  "diversify",
  "switch tracks",
];

// ─── Main entry point ────────────────────────────────────────────────────

export function computeIntrospection(args: {
  repo: Repo;
  logsDir: string;
  /** Optional time floor: only consider events/picks >= sinceMs. */
  sinceMs?: number;
}): IntrospectionReport {
  const { repo, logsDir, sinceMs } = args;
  const nodes = repo.listNodes();
  const allEdges = collectAllEdges(repo, nodes);

  return {
    generated_at: Date.now(),
    graph_summary: graphSummary(nodes, allEdges),
    generative_vs_revision: computeGenerativeVsRevision(repo, nodes, sinceMs),
    axis_balance: computeAxisBalance(allEdges),
    knowledge_capital: computeKnowledgeCapital(nodes),
    re_extrapolation: computeReExtrapolation(nodes, allEdges, logsDir, sinceMs),
    lateral_movement: computeLateralMovement(nodes, allEdges, logsDir, sinceMs),
    scheduler_rationales: computeSchedulerRationales(logsDir, sinceMs),
  };
}

// ─── Implementations ─────────────────────────────────────────────────────

function graphSummary(
  nodes: Node[],
  edges: { id: string; type: string; from_id: string; to_id: string }[],
): GraphSummary {
  const byStatus: Record<string, number> = {};
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const n of nodes) {
    byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
    if (n.created_at < earliest) earliest = n.created_at;
    if (n.updated_at > latest) latest = n.updated_at;
  }
  return {
    total_nodes: nodes.length,
    total_edges: edges.length,
    by_status: byStatus,
    spans_ms: {
      earliest: Number.isFinite(earliest) ? earliest : 0,
      latest,
    },
  };
}

function computeGenerativeVsRevision(
  repo: Repo,
  nodes: Node[],
  sinceMs?: number,
): GenerativeVsRevision {
  const histogram: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4+": 0 };
  for (const n of nodes) {
    const r = n.revision;
    if (r <= 1) histogram["1"]!++;
    else if (r === 2) histogram["2"]!++;
    else if (r === 3) histogram["3"]!++;
    else histogram["4+"]!++;
  }

  // For time-binned creation/update activity we read the events table.
  // We don't have a query helper for "all events" so use recentEvents
  // with a generous limit; if the user runs against a million-event run
  // we'd lift this to a paged query, but at our scale a single 50k pull
  // is fine.
  const events = repo.recentEvents(50_000);
  const totalCreated = events.filter((e) => e.type === "node_created").length;
  const totalUpdated = events.filter((e) => e.type === "node_updated").length;

  const filtered = events.filter(
    (e) =>
      (e.type === "node_created" || e.type === "node_updated") &&
      (sinceMs === undefined || e.created_at >= sinceMs),
  );
  filtered.sort((a, b) => a.created_at - b.created_at);

  const buckets: TimeBucket[] = [];
  if (filtered.length > 0) {
    const start = filtered[0]!.created_at;
    const end = filtered[filtered.length - 1]!.created_at;
    const span = Math.max(1, end - start);
    // ~12 buckets, never finer than 5 min, never coarser than 24h.
    const bucketMs = clamp(Math.ceil(span / 12), 5 * 60 * 1000, 24 * 3600 * 1000);
    for (let t = start; t <= end; t += bucketMs) {
      buckets.push({
        start: t,
        end: t + bucketMs,
        created: 0,
        updated: 0,
      });
    }
    for (const ev of filtered) {
      const idx = Math.min(
        buckets.length - 1,
        Math.floor((ev.created_at - start) / bucketMs),
      );
      const b = buckets[idx];
      if (!b) continue;
      if (ev.type === "node_created") b.created++;
      else b.updated++;
    }
  }

  return {
    total_creations: totalCreated,
    total_updates: totalUpdated,
    updates_per_node:
      nodes.length > 0
        ? Math.round((totalUpdated / nodes.length) * 100) / 100
        : 0,
    revision_histogram: histogram,
    time_buckets: buckets,
  };
}

function axisOf(edgeType: string): AxisKind {
  switch (edgeType) {
    case "subtask_of":
    case "depends_on":
      return "down";
    case "risk_of":
    case "contingent_on":
    case "outcome_of":
      return "forward";
    case "rationale_for":
    case "derives_from":
      return "back";
    case "ladders_up_to":
    case "supersedes":
      return "up";
    case "mentions":
    case "relates_to":
      return "lateral";
    default:
      return "other";
  }
}

function computeAxisBalance(
  edges: { type: string }[],
): AxisBalance {
  const axes: Record<AxisKind, AxisRow> = {
    down: { count: 0, fraction: 0, edge_types: {} },
    forward: { count: 0, fraction: 0, edge_types: {} },
    back: { count: 0, fraction: 0, edge_types: {} },
    up: { count: 0, fraction: 0, edge_types: {} },
    lateral: { count: 0, fraction: 0, edge_types: {} },
    other: { count: 0, fraction: 0, edge_types: {} },
  };
  for (const e of edges) {
    const k = axisOf(e.type);
    axes[k].count++;
    axes[k].edge_types[e.type] = (axes[k].edge_types[e.type] ?? 0) + 1;
  }
  const total = edges.length || 1;
  for (const k of Object.keys(axes) as AxisKind[]) {
    axes[k].fraction = Math.round((axes[k].count / total) * 1000) / 1000;
  }
  return { axes };
}

function computeKnowledgeCapital(nodes: Node[]): KnowledgeCapital {
  const byType: Record<string, number> = {};
  let thinking = 0;
  let doing = 0;
  let researchTotal = 0;
  let researchAnswered = 0;
  for (const n of nodes) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    if (THINKING_TYPES.has(n.type)) thinking++;
    else if (DOING_TYPES.has(n.type)) doing++;
    if (n.type === "research") {
      researchTotal++;
      // "Answered" = body has more than a trivial amount of content. We
      // use 200 chars as a conservative threshold — more than a one-line
      // placeholder, less than a real investigation.
      if ((n.body ?? "").trim().length >= 200) researchAnswered++;
    }
  }
  const total = thinking + doing || 1;
  return {
    thinking_count: thinking,
    doing_count: doing,
    thinking_fraction: Math.round((thinking / total) * 1000) / 1000,
    by_type: byType,
    research_followthrough: {
      total: researchTotal,
      answered: researchAnswered,
      unanswered: researchTotal - researchAnswered,
    },
  };
}

function computeReExtrapolation(
  nodes: Node[],
  edges: { from_id: string; to_id: string; type: string }[],
  logsDir: string,
  sinceMs?: number,
): ReExtrapolation {
  // Collect every extrapolate cycle_started event. We read the ndjson
  // files matching `__extrapolate__*.ndjson` directly — they record the
  // source_id we cycled, which the events table doesn't currently
  // surface in a queryable way.
  const calls = readExtrapolateCalls(logsDir, sinceMs);

  // Re-cycle = a call whose source_id appeared in an earlier call.
  const seen = new Map<string, number>();
  let recycled = 0;
  for (const c of calls) {
    const prev = seen.get(c.source_id) ?? 0;
    if (prev > 0) recycled++;
    seen.set(c.source_id, prev + 1);
  }

  // Children-already-executed: for each call, was any descendant
  // (via subtask_of, recursively) marked done before this call's
  // timestamp?
  const childrenOf = buildChildrenIndex(edges); // parent_id -> [child_id]
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  let onParentAfterDescendantExecuted = 0;
  for (const c of calls) {
    const descendants = collectDescendants(childrenOf, c.source_id);
    let anyExecutedBefore = false;
    for (const d of descendants) {
      const node = nodeById.get(d);
      if (
        node &&
        node.completed_at !== null &&
        node.completed_at < c.started_at
      ) {
        anyExecutedBefore = true;
        break;
      }
    }
    if (anyExecutedBefore) onParentAfterDescendantExecuted++;
  }

  const examples = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source_id, count]) => ({ source_id, count }));

  return {
    total_extrapolate_calls: calls.length,
    on_previously_cycled_nodes: recycled,
    on_parent_after_descendant_executed: onParentAfterDescendantExecuted,
    examples,
  };
}

function computeLateralMovement(
  nodes: Node[],
  edges: { from_id: string; to_id: string }[],
  logsDir: string,
  sinceMs?: number,
): LateralMovement {
  // Read iteration_started events from loop ndjson — they're our
  // sequence of scheduler picks. Order by timestamp.
  const picks = readSchedulerPicks(logsDir, sinceMs);

  // Build an undirected adjacency for graph distance. We treat all
  // edge types as connectivity for the purposes of "how far apart are
  // these nodes in the network".
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.from_id)) adj.set(e.from_id, new Set());
    if (!adj.has(e.to_id)) adj.set(e.to_id, new Set());
    adj.get(e.from_id)!.add(e.to_id);
    adj.get(e.to_id)!.add(e.from_id);
  }
  const allIds = new Set(nodes.map((n) => n.id));

  const histogram: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5+": 0,
    disconnected: 0,
  };
  const distances: number[] = [];
  for (let i = 1; i < picks.length; i++) {
    const a = picks[i - 1]!.node_id;
    const b = picks[i]!.node_id;
    if (!allIds.has(a) || !allIds.has(b)) continue;
    const d = bfsDistance(adj, a, b, 6);
    if (d === Number.POSITIVE_INFINITY) {
      histogram.disconnected!++;
    } else if (d <= 4) {
      const key = String(d);
      histogram[key] = (histogram[key] ?? 0) + 1;
      distances.push(d);
    } else {
      histogram["5+"]!++;
      distances.push(d);
    }
  }
  distances.sort((a, b) => a - b);
  const median =
    distances.length === 0
      ? 0
      : distances[Math.floor(distances.length / 2)] ?? 0;
  const mean =
    distances.length === 0
      ? 0
      : Math.round(
          (distances.reduce((s, x) => s + x, 0) / distances.length) * 100,
        ) / 100;

  return {
    scheduler_picks: picks.length,
    distance_histogram: histogram,
    median_distance: median,
    mean_distance: mean,
  };
}

function computeSchedulerRationales(
  logsDir: string,
  sinceMs?: number,
): SchedulerRationales {
  const decisions = readSchedulerDecisions(logsDir, sinceMs);
  const examples = {
    exploit: [] as string[],
    explore: [] as string[],
    neutral: [] as string[],
  };
  let exploit = 0;
  let explore = 0;
  let neutral = 0;
  for (const d of decisions) {
    const lc = d.rationale.toLowerCase();
    const isExploit = EXPLOIT_KEYWORDS.some((k) => lc.includes(k));
    const isExplore = EXPLORE_KEYWORDS.some((k) => lc.includes(k));
    if (isExplore && !isExploit) {
      explore++;
      if (examples.explore.length < 5) examples.explore.push(d.rationale);
    } else if (isExploit && !isExplore) {
      exploit++;
      if (examples.exploit.length < 5) examples.exploit.push(d.rationale);
    } else {
      neutral++;
      if (examples.neutral.length < 5) examples.neutral.push(d.rationale);
    }
  }
  return {
    total_decisions: decisions.length,
    classified: { exploit, explore, neutral },
    examples,
  };
}

// ─── Log scanners ────────────────────────────────────────────────────────

interface ExtrapolateCall {
  source_id: string;
  started_at: number;
}

function readExtrapolateCalls(
  logsDir: string,
  sinceMs?: number,
): ExtrapolateCall[] {
  const out: ExtrapolateCall[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".ndjson")) continue;
    if (!name.includes("__extrapolate__")) continue;
    const text = readSafe(path.join(logsDir, name));
    if (!text) continue;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        if (ev.kind !== "cycle_started") continue;
        const sourceId = typeof ev.source_id === "string" ? ev.source_id : "";
        const t = typeof ev.t === "number" ? ev.t : 0;
        if (!sourceId || !t) continue;
        if (sinceMs !== undefined && t < sinceMs) continue;
        out.push({ source_id: sourceId, started_at: t });
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => a.started_at - b.started_at);
  return out;
}

interface Pick {
  node_id: string;
  kind: "cycle" | "execute";
  at: number;
}

function readSchedulerPicks(logsDir: string, sinceMs?: number): Pick[] {
  // We use scheduler_decided events here (and below for rationales) rather
  // than iteration_started: the loop logger spreads its data into a
  // {t, kind, ...data} envelope, and iteration_started's data carries
  // its own kind={cycle,execute} which clobbers the event label. The
  // scheduler_decided event carries both node_id and action without a
  // kind clash, so it's the cleaner read.
  const out: Pick[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".ndjson")) continue;
    if (!name.includes("__loop__")) continue;
    const text = readSafe(path.join(logsDir, name));
    if (!text) continue;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        if (ev.kind !== "scheduler_decided") continue;
        const nodeId = typeof ev.node_id === "string" ? ev.node_id : "";
        const action = typeof ev.action === "string" ? ev.action : "";
        const t = typeof ev.t === "number" ? ev.t : 0;
        if (!nodeId || !t) continue;
        if (sinceMs !== undefined && t < sinceMs) continue;
        out.push({
          node_id: nodeId,
          kind: action === "cycle" ? "cycle" : "execute",
          at: t,
        });
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

interface Decision {
  rationale: string;
  at: number;
}

function readSchedulerDecisions(
  logsDir: string,
  sinceMs?: number,
): Decision[] {
  const out: Decision[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".ndjson")) continue;
    if (!name.includes("__loop__")) continue;
    const text = readSafe(path.join(logsDir, name));
    if (!text) continue;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        if (ev.kind !== "scheduler_decided") continue;
        const r =
          typeof ev.rationale === "string" ? ev.rationale.trim() : "";
        const t = typeof ev.t === "number" ? ev.t : 0;
        if (!r || !t) continue;
        if (sinceMs !== undefined && t < sinceMs) continue;
        out.push({ rationale: r, at: t });
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function collectAllEdges(
  repo: Repo,
  nodes: Node[],
): { id: string; type: string; from_id: string; to_id: string }[] {
  const seen = new Set<string>();
  const out: { id: string; type: string; from_id: string; to_id: string }[] = [];
  for (const n of nodes) {
    for (const e of repo.edgesFrom(n.id)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({
        id: e.id,
        type: e.type,
        from_id: e.from_id,
        to_id: e.to_id,
      });
    }
  }
  return out;
}

function buildChildrenIndex(
  edges: { from_id: string; to_id: string; type: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== "subtask_of") continue;
    // from = child, to = parent
    const arr = out.get(e.to_id) ?? [];
    arr.push(e.from_id);
    out.set(e.to_id, arr);
  }
  return out;
}

function collectDescendants(
  childrenOf: Map<string, string[]>,
  rootId: string,
): string[] {
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>([rootId]);
  while (stack.length) {
    const n = stack.pop()!;
    for (const c of childrenOf.get(n) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

function bfsDistance(
  adj: Map<string, Set<string>>,
  a: string,
  b: string,
  cap: number,
): number {
  if (a === b) return 0;
  const seen = new Set<string>([a]);
  let frontier: string[] = [a];
  let depth = 0;
  while (frontier.length && depth < cap) {
    depth++;
    const next: string[] = [];
    for (const node of frontier) {
      for (const nb of adj.get(node) ?? []) {
        if (nb === b) return depth;
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return Number.POSITIVE_INFINITY;
}

function readSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
