import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";

/**
 * Parent-recycle reflex.
 *
 * After a leaf execution succeeds, check whether the leaf's immediate
 * parent (via subtask_of) has had every one of its direct children
 * "touched" — meaning each child's status is one of {in_progress,
 * done, blocked, cancelled}. If so, return the parent so the loop
 * can re-cycle it (re-extrapolate it with the now-richer graph
 * context). Returns null when:
 *
 * - the leaf has no parent
 * - the parent is a root_purpose (we deliberately skip those — the
 *   user opted out of forced root recycles for now)
 * - some sibling is still status="open"
 * - the parent itself isn't open or in_progress (already done /
 *   cancelled / blocked → don't disturb)
 *
 * We don't recurse: only the leaf's *immediate* parent is considered.
 * Recursing further would create cascading cycles every time a leaf
 * completes a long chain, which is more aggressive than the user
 * asked for.
 */
export function findRecycleableParent(
  repo: Repo,
  leafId: string,
): Node | null {
  const parentEdges = repo.edgesFrom(leafId, "subtask_of");
  if (parentEdges.length === 0) return null;
  // Multiple parents are unusual but possible (relates_to via subtask_of
  // is rare). Take the first; same heuristic the scheduler uses.
  const parentId = parentEdges[0]!.to_id;
  const parent = repo.getNode(parentId);
  if (!parent) return null;
  if (parent.type === "root_purpose") return null;
  if (parent.status !== "open" && parent.status !== "in_progress") return null;

  const childIds = repo
    .edgesTo(parentId, "subtask_of")
    .map((e) => e.from_id);
  if (childIds.length === 0) return null;
  for (const cid of childIds) {
    const c = repo.getNode(cid);
    if (!c) continue;
    if (c.status === "open") return null;
  }
  return parent;
}
