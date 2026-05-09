import fs from "node:fs";
import path from "node:path";
import type { Repo } from "../graph/repo.js";
import type { Edge, Node } from "../graph/schema.js";
import { ancestors, descendants } from "../graph/traversal.js";

/**
 * Refresh the per-leaf brief files inside the persistent agent workspace.
 *
 * This used to create a per-session workspace dir with AGENTS.md +
 * WORK_CONTEXT.md + RESULT_SCHEMA.md. With shared state (PR #10):
 *  - AGENTS.md, SOUL.md, IDENTITY.md, MEMORY.md are PERSISTENT (managed
 *    by ensureAgentIdentity once and by openclaw's memory plugins
 *    afterward).
 *  - CURRENT_LEAF.md / WORK_CONTEXT.md / RESULT_SCHEMA.md are OVERWRITTEN
 *    each leaf — they describe the current task only.
 *  - progress.json / result.json are deleted before the run so prior
 *    session's artifacts don't confuse the agent.
 */
export interface BootstrapResult {
  workspaceDir: string;
  contextMarkdown: string;
}

/** Hard timeout enforced by openclaw, in seconds. Internal — not surfaced
 *  to the agent. The agent works without knowing about a clock; the
 *  checkpoint pattern (progress.json) handles durability. */
export const HARD_TIMEOUT_SEC = 1800;

export function bootstrapWorkspace(
  repo: Repo,
  args: {
    /** Persistent agent workspace (cwd for openclaw subprocess). */
    workspaceDir: string;
    leafId: string;
    rootPurposeId?: string | null;
  },
): BootstrapResult {
  const workspaceDir = args.workspaceDir;
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Clear any leftover progress/result/envelope from the previous leaf.
  for (const stale of ["progress.json", "result.json", "envelope.json"]) {
    const p = path.join(workspaceDir, stale);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const leaf = repo.getNode(args.leafId);
  if (!leaf) throw new Error(`leaf node ${args.leafId} not found`);

  const ancestorsList = ancestors(repo, leaf.id);
  const root = args.rootPurposeId
    ? repo.getNode(args.rootPurposeId)
    : ancestorsList.find((n) => n.type === "root_purpose") ?? null;

  // Sibling tasks under the immediate parent — useful context for "what else
  // is in progress at this level" without flooding the prompt.
  const parentEdges = repo.edgesFrom(leaf.id, "subtask_of");
  const parent =
    parentEdges.length > 0 ? repo.getNode(parentEdges[0]!.to_id) : null;
  const siblings: Node[] = [];
  if (parent) {
    const childEdges = repo.edgesTo(parent.id, "subtask_of");
    for (const e of childEdges) {
      if (e.from_id === leaf.id) continue;
      const s = repo.getNode(e.from_id);
      if (s) siblings.push(s);
    }
  }

  // Risks pointing AT this leaf or its parent — agent should be aware.
  const risksOnLeaf = repo
    .edgesTo(leaf.id, "risk_of")
    .map((e) => repo.getNode(e.from_id))
    .filter((n): n is Node => n !== null && n.type === "risk");
  const risksOnParent = parent
    ? repo
        .edgesTo(parent.id, "risk_of")
        .map((e) => repo.getNode(e.from_id))
        .filter((n): n is Node => n !== null && n.type === "risk")
    : [];

  // Rationale nodes pointing at the leaf or its parent — explain WHY.
  const rationaleOnLeaf = repo
    .edgesTo(leaf.id, "rationale_for")
    .map((e) => repo.getNode(e.from_id))
    .filter((n): n is Node => n !== null);
  const rationaleOnParent = parent
    ? repo
        .edgesTo(parent.id, "rationale_for")
        .map((e) => repo.getNode(e.from_id))
        .filter((n): n is Node => n !== null)
    : [];

  // Wider graph slice: open + recently-completed tasks under the same root,
  // concept/entity neighbors via mentions edges, root-level risks/rationale.
  // The agent's awareness is the whole subtree, even though its action is
  // this one leaf.
  const rootSubtree: Node[] = root
    ? descendants(repo, root.id)
    : [];
  const otherOpenTasks = rootSubtree.filter(
    (n) =>
      n.id !== leaf.id &&
      n.type === "task" &&
      (n.status === "open" || n.status === "in_progress"),
  );
  const recentlyCompleted = rootSubtree
    .filter((n) => n.type === "task" && n.status === "done" && n.completed_at != null)
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
    .slice(0, 8);

  // Concept / entity neighbors — semantic context.
  const mentionedNeighbors = collectMentioned(repo, leaf.id);
  // Cross-cutting risks & rationale at root level (not just on the leaf path).
  const rootLevelRisks = root
    ? rootSubtree
        .filter((n) => n.type === "risk")
        .filter(
          (n) =>
            !risksOnLeaf.some((r) => r.id === n.id) &&
            !risksOnParent.some((r) => r.id === n.id),
        )
        .slice(0, 6)
    : [];
  const rootLevelRationale = root
    ? rootSubtree
        .filter((n) => n.type === "rationale")
        .filter(
          (n) =>
            !rationaleOnLeaf.some((r) => r.id === n.id) &&
            !rationaleOnParent.some((r) => r.id === n.id),
        )
        .slice(0, 4)
    : [];

  const contextMarkdown = renderContext({
    leaf,
    root,
    parent,
    ancestors: ancestorsList,
    siblings: siblings.slice(0, 12),
    risks: [...risksOnLeaf, ...risksOnParent].slice(0, 6),
    rationale: [...rationaleOnLeaf, ...rationaleOnParent].slice(0, 6),
    priorSummary: priorSessionSummary(leaf),
    otherOpenTasks: otherOpenTasks.slice(0, 30),
    recentlyCompleted,
    mentionedNeighbors,
    rootLevelRisks,
    rootLevelRationale,
  });

  // CURRENT_LEAF.md and WORK_CONTEXT.md and RESULT_SCHEMA.md get
  // refreshed each leaf. AGENTS.md, SOUL.md, IDENTITY.md are owned by
  // ensureAgentIdentity (persistent across leaves).
  fs.writeFileSync(
    path.join(workspaceDir, "CURRENT_LEAF.md"),
    renderCurrentLeafMd(leaf, root),
  );
  fs.writeFileSync(path.join(workspaceDir, "WORK_CONTEXT.md"), contextMarkdown);
  fs.writeFileSync(
    path.join(workspaceDir, "RESULT_SCHEMA.md"),
    renderResultSchemaMd(),
  );

  return { workspaceDir, contextMarkdown };
}

function renderCurrentLeafMd(leaf: Node, root: Node | null): string {
  return `# Current leaf

> ${leaf.title}

${leaf.body || "_(no body — see WORK_CONTEXT.md for surrounding graph)_"}

${root ? `\nServes root purpose: **${root.title}**.\n` : ""}
Read \`AGENTS.md\` for your standing operating principles, \`WORK_CONTEXT.md\`
for the surrounding graph, and \`RESULT_SCHEMA.md\` for the file shapes
to write. Then do the work and either checkpoint via \`progress.json\`
or finish with \`result.json\`.
`;
}



function renderResultSchemaMd(): string {
  return `# Result schema

Two files in this workspace use the same schema:

- \`progress.json\` — checkpoints written periodically while work is
  ongoing. Status is \`"in_progress"\`.
- \`result.json\` — the final verdict, written when you're truly done.
  Status is \`"done"\` / \`"blocked"\` / \`"needs_decomposition"\` /
  \`"cancelled"\`.

If \`result.json\` is missing when your session ends, Trellis falls back
to the most recent \`progress.json\`, so checkpointing is your safety
net for long work.

\`\`\`json
{
  "status": "done | blocked | needs_decomposition | cancelled | in_progress",
  "summary": "One paragraph describing what you've accomplished. For progress.json, this captures state-so-far.",
  "notes": [
    {
      "title": "Short title for a note node",
      "body": "Markdown body — observations, key findings, decisions."
    }
  ],
  "new_tasks": [
    {
      "title": "Imperative title for a new subtask",
      "body": "What success looks like.",
      "priority": 0.7,
      "atomic": true
    }
  ],
  "blocker": "Optional. Explain what's missing if status=blocked or needs_decomposition.",
  "artifacts": ["relative/path/to/file/you/produced.ts"]
}
\`\`\`

Required fields: \`status\`, \`summary\`. Everything else is optional;
omit if not applicable. The file MUST parse as JSON — no comments, no
trailing commas.

If you produced files in this workspace, list them in \`artifacts\` so
Trellis can find them later.
`;
}

/**
 * If this leaf has been worked on before — either fully (status=in_progress
 * after a progress.json checkpoint, or a re-picked done leaf for re-check)
 * — pull the prior session's summary off metadata so the new session can
 * pick up where the last left off.
 */
function priorSessionSummary(leaf: Node): string | null {
  const meta = leaf.metadata as Record<string, unknown>;
  const summary = meta.last_session_summary;
  const source = meta.last_result_source;
  if (typeof summary !== "string" || summary.length === 0) return null;
  if (source === "progress") return summary;
  // For non-progress sources we still surface the summary as background,
  // but only if the leaf is still open (re-picked work).
  if (leaf.status === "open" || leaf.status === "in_progress") {
    return summary;
  }
  return null;
}

/**
 * Pull every concept / entity / timeframe / memory / note that mentions
 * the leaf or any of its immediate ancestors. These are the agent's
 * semantic neighbors — recurring ideas, named entities, time pressures.
 */
function collectMentioned(repo: Repo, leafId: string): Node[] {
  const seen = new Set<string>();
  const out: Node[] = [];
  // Direct mentions of the leaf.
  for (const e of repo.edgesTo(leafId, "mentions")) {
    pushIfNew(repo, e.from_id, seen, out);
  }
  // Mentions of immediate ancestors (one hop up).
  for (const e of repo.edgesFrom(leafId, "subtask_of")) {
    for (const m of repo.edgesTo(e.to_id, "mentions")) {
      pushIfNew(repo, m.from_id, seen, out);
    }
  }
  // Allow related concepts the leaf references via relates_to.
  for (const e of repo.edgesFrom(leafId, "relates_to")) {
    pushIfNew(repo, e.to_id, seen, out);
  }
  return out
    .filter((n) =>
      ["concept", "entity", "timeframe", "memory", "note"].includes(n.type),
    )
    .slice(0, 12);
}

function pushIfNew(
  repo: Repo,
  id: string,
  seen: Set<string>,
  out: Node[],
): void {
  if (seen.has(id)) return;
  const n = repo.getNode(id);
  if (!n) return;
  seen.add(id);
  out.push(n);
}

function renderContext(args: {
  leaf: Node;
  root: Node | null;
  parent: Node | null;
  ancestors: Node[];
  siblings: Node[];
  risks: Node[];
  rationale: Node[];
  priorSummary: string | null;
  otherOpenTasks: Node[];
  recentlyCompleted: Node[];
  mentionedNeighbors: Node[];
  rootLevelRisks: Node[];
  rootLevelRationale: Node[];
}): string {
  const lines: string[] = [];
  lines.push(`# Work context for: ${args.leaf.title}\n`);
  lines.push(`## Leaf task (the thing you're doing)\n`);
  lines.push(`**${args.leaf.title}**`);
  lines.push("");
  lines.push(args.leaf.body || "_(no body)_");

  if (args.priorSummary) {
    lines.push(`\n## Prior session progress\n`);
    lines.push(
      `A previous session worked on this leaf and either checkpointed or completed verification. Their summary:\n`,
    );
    lines.push(`> ${args.priorSummary.replace(/\n/g, "\n> ")}`);
    lines.push(
      `\nPick up where they left off rather than redoing the same investigation.`,
    );
  }

  if (args.root) {
    lines.push(`\n## Root purpose\n`);
    lines.push(`**${args.root.title}**`);
    if (args.root.body) lines.push(args.root.body);
  }

  if (args.parent) {
    lines.push(`\n## Immediate parent task\n`);
    lines.push(`**${args.parent.title}**`);
    if (args.parent.body) lines.push(args.parent.body);
  }

  if (args.ancestors.length > 1) {
    lines.push(`\n## Ancestor chain (closest → root)\n`);
    for (const n of args.ancestors) {
      lines.push(`- **${n.type}** — ${n.title}`);
    }
  }

  if (args.siblings.length > 0) {
    lines.push(`\n## Sibling tasks (same parent)\n`);
    for (const n of args.siblings) {
      lines.push(`- [${n.status}] ${n.title}`);
    }
  }

  if (args.rationale.length > 0) {
    lines.push(`\n## Rationale (why this matters)\n`);
    for (const n of args.rationale) {
      lines.push(`- **${n.title}**`);
      if (n.body) lines.push(`  ${n.body.slice(0, 400)}`);
    }
  }

  if (args.risks.length > 0) {
    lines.push(`\n## Risks (on the leaf or its parent)\n`);
    for (const n of args.risks) {
      lines.push(`- **${n.title}**`);
      if (n.body) lines.push(`  ${n.body.slice(0, 400)}`);
    }
  }

  if (args.rootLevelRisks.length > 0) {
    lines.push(`\n## Cross-cutting risks (root-wide)\n`);
    lines.push(
      `These risks aren't bound to your immediate path but matter for the broader project. Skim for relevance.\n`,
    );
    for (const n of args.rootLevelRisks) {
      lines.push(`- **${n.title}**`);
      if (n.body) lines.push(`  ${n.body.slice(0, 240)}`);
    }
  }

  if (args.rootLevelRationale.length > 0) {
    lines.push(`\n## Cross-cutting rationale (root-wide)\n`);
    for (const n of args.rootLevelRationale) {
      lines.push(`- **${n.title}**`);
      if (n.body) lines.push(`  ${n.body.slice(0, 240)}`);
    }
  }

  if (args.otherOpenTasks.length > 0) {
    lines.push(`\n## Other open tasks under this root (${args.otherOpenTasks.length})\n`);
    lines.push(
      `Awareness only — don't start work on these. But notice if your leaf overlaps, duplicates, or unblocks any of them.\n`,
    );
    for (const n of args.otherOpenTasks) {
      const flag = (n.metadata as Record<string, unknown>).atomic === true ? "atomic" : "compound";
      lines.push(`- [${n.status}] [${flag}] ${n.title}  \`${n.id.slice(0, 8)}\``);
    }
  }

  if (args.recentlyCompleted.length > 0) {
    lines.push(`\n## Recently completed under this root\n`);
    lines.push(
      `What's been finished in adjacent space. Read the summaries to avoid redoing work and to know what's already true.\n`,
    );
    for (const n of args.recentlyCompleted) {
      const summary =
        (n.metadata as Record<string, unknown>).last_session_summary;
      const summaryLine = typeof summary === "string"
        ? `\n  > ${String(summary).slice(0, 280).replace(/\n/g, "\n  > ")}`
        : "";
      lines.push(`- ✓ ${n.title}${summaryLine}`);
    }
  }

  if (args.mentionedNeighbors.length > 0) {
    lines.push(`\n## Semantic neighbors (concepts / entities / timeframes / notes)\n`);
    lines.push(
      `Things the graph has indexed near this leaf. Read them as background context.\n`,
    );
    for (const n of args.mentionedNeighbors) {
      lines.push(`- **${n.type}** ${n.title}`);
      if (n.body) lines.push(`  ${n.body.slice(0, 240)}`);
    }
  }

  return lines.join("\n");
}

// kept for future imports if traversal helpers move; silences unused import.
void (null as unknown as Edge[]);
