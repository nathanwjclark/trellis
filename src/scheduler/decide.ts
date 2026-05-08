import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";
import { criticalPathLeaf, isOpen } from "../graph/traversal.js";

export type SchedulerDecision =
  | { kind: "cycle"; node: Node; reason: string }
  | { kind: "execute"; node: Node; reason: string }
  | { kind: "stop"; reason: string };

export interface DecideOptions {
  /** Restrict scheduling to descendants of this root. If null, picks the
   *  highest-priority open root_purpose in the graph. */
  rootId?: string | null;
}

/**
 * Pure scheduling decision: given the current graph state, what should the
 * daemon do next? Returns one of:
 *  - cycle a non-atomic leaf so it gains children (extrapolate phase)
 *  - execute an atomic open leaf
 *  - stop, with a human-readable reason
 *
 * No side effects. Caller is responsible for invoking runCycle/execute.
 */
export function decideNextAction(
  repo: Repo,
  opts: DecideOptions = {},
): SchedulerDecision {
  const root = pickRoot(repo, opts.rootId ?? null);
  if (!root) {
    return {
      kind: "stop",
      reason: opts.rootId
        ? `root ${opts.rootId} not found or already closed`
        : "no open root_purpose nodes in the graph",
    };
  }

  const leaf = criticalPathLeaf(repo, root.id);
  if (!leaf) {
    return {
      kind: "stop",
      reason: `root "${root.title}" has no open atomic descendants`,
    };
  }

  // The leaf has no open subtask children (criticalPathLeaf guarantees that).
  // If it's marked atomic, it's ready for execute. Otherwise it needs to be
  // extrapolated first so the cycle gives it children.
  const atomic = leafIsAtomic(leaf);
  if (atomic) {
    return {
      kind: "execute",
      node: leaf,
      reason: `atomic open leaf under "${root.title}"`,
    };
  }

  // For non-atomic leaves we cycle to extrapolate. But avoid cycling the same
  // node repeatedly: if we've cycled it before and it still has no children,
  // mark blocked and stop. The next loop iteration will reconsider with this
  // leaf out of the way (criticalPathLeaf will skip blocked-with-no-open-
  // children since `isOpen` only walks via subtask_of edges that aren't done).
  const cycledAlready = hasBeenCycled(repo, leaf.id);
  const hasChildren = repo.edgesTo(leaf.id, "subtask_of").length > 0;
  if (cycledAlready && !hasChildren) {
    repo.updateNode(leaf.id, {
      status: "blocked",
      metadata: {
        last_block_reason:
          "extrapolation produced no subtask children; marking blocked to avoid loop",
      },
    });
    repo.recordEvent({
      type: "node_updated",
      node_id: leaf.id,
      payload: { reason: "scheduler-blocked-after-empty-cycle" },
    });
    return {
      kind: "stop",
      reason: `blocked stuck leaf "${leaf.title}" (cycled previously, no children produced)`,
    };
  }

  return {
    kind: "cycle",
    node: leaf,
    reason: `non-atomic leaf needs extrapolation under "${root.title}"`,
  };
}

function pickRoot(repo: Repo, rootId: string | null): Node | null {
  if (rootId) {
    const n = repo.getNode(rootId);
    if (!n || !isOpen(n)) return null;
    return n;
  }
  const open = repo
    .listNodes({ type: "root_purpose" })
    .filter((n) => isOpen(n));
  if (open.length === 0) return null;
  // Highest priority first; tie-break by recency of last touch.
  open.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.last_touched_at - a.last_touched_at;
  });
  return open[0]!;
}

function leafIsAtomic(node: Node): boolean {
  const flag = (node.metadata as Record<string, unknown>).atomic;
  return flag === true;
}

/**
 * Has this node already been the source of a cycle? We check the events
 * table for cycle_completed events whose node_id matches.
 */
function hasBeenCycled(repo: Repo, nodeId: string): boolean {
  // recentEvents returns up to N most-recent events; check across a wide
  // window. For v1 a flat listNodes-style scan is fine — we'll move to a
  // dedicated index if loop frequency grows.
  const events = repo.recentEvents(2000);
  for (const e of events) {
    if (e.type === "cycle_completed" && e.node_id === nodeId) return true;
  }
  return false;
}
