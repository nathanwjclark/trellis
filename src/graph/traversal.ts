import type { Repo } from "./repo.js";
import type { Edge, EdgeType, Node } from "./schema.js";

/**
 * Breadth-first descendants following edges of `kinds` in the *to* direction.
 * For example, to walk all subtasks under a task, follow `subtask_of` edges
 * inbound to the task (children point at parents via subtask_of).
 *
 * Direction:
 *  - "outbound": follow edges from the seed
 *  - "inbound":  follow edges pointing at the seed (typical for subtask_of)
 */
export function walk(
  repo: Repo,
  seed: string,
  kinds: EdgeType[],
  direction: "inbound" | "outbound",
  opts: { maxDepth?: number; includeSeed?: boolean } = {},
): Node[] {
  const maxDepth = opts.maxDepth ?? 32;
  const seen = new Set<string>([seed]);
  const out: Node[] = [];
  if (opts.includeSeed) {
    const s = repo.getNode(seed);
    if (s) out.push(s);
  }
  let frontier: string[] = [seed];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next: string[] = [];
    for (const id of frontier) {
      const edges: Edge[] = [];
      for (const k of kinds) {
        edges.push(...(direction === "inbound" ? repo.edgesTo(id, k) : repo.edgesFrom(id, k)));
      }
      for (const e of edges) {
        const nbr = direction === "inbound" ? e.from_id : e.to_id;
        if (seen.has(nbr)) continue;
        seen.add(nbr);
        const n = repo.getNode(nbr);
        if (n) {
          out.push(n);
          next.push(nbr);
        }
      }
    }
    frontier = next;
    depth++;
  }
  return out;
}

/** All descendant tasks under a task root (children link up via subtask_of). */
export function descendants(repo: Repo, taskId: string): Node[] {
  return walk(repo, taskId, ["subtask_of"], "inbound");
}

/** Strategic ancestors via ladders_up_to + subtask_of. */
export function ancestors(repo: Repo, taskId: string): Node[] {
  return walk(repo, taskId, ["subtask_of", "ladders_up_to"], "outbound");
}

/**
 * Critical-path leaf: descend from `rootId` along subtask_of edges, choosing
 * the open child with the highest (priority * edge.weight) at each step. Stops
 * when the current node has no open subtask children.
 */
export function criticalPathLeaf(repo: Repo, rootId: string): Node | null {
  let current = repo.getNode(rootId);
  if (!current) return null;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current.id)) return current;
    seen.add(current.id);
    const childEdges = repo.edgesTo(current.id, "subtask_of");
    let best: { node: Node; score: number } | null = null;
    for (const e of childEdges) {
      const child = repo.getNode(e.from_id);
      if (!child) continue;
      if (child.type !== "task" && child.type !== "root_purpose") continue;
      if (!isOpen(child)) continue;
      const score = child.priority * e.weight;
      if (!best || score > best.score) best = { node: child, score };
    }
    if (!best) return isOpen(current) ? current : null;
    current = best.node;
  }
}

export function isOpen(n: Node): boolean {
  // human_blocked is *not* open — it's parked waiting for a human and
  // shouldn't be picked by the scheduler.
  return n.status === "open" || n.status === "in_progress" || n.status === "blocked";
}
