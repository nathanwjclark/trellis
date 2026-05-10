import fs from "node:fs";
import path from "node:path";
import type { Repo } from "../graph/repo.js";
import type { Edge, Node } from "../graph/schema.js";
import { ancestors, descendants } from "../graph/traversal.js";

/** Where Trellis writes its transient brief files within a workspace.
 *  Keeps the workspace root unpolluted — important in prod mode where
 *  the workspace is user-owned. */
export const TRELLIS_SUBDIR = ".trellis";

/**
 * Refresh the per-leaf brief files inside the persistent agent workspace.
 *
 * Layout (PR #12):
 *  - AGENTS.md, SOUL.md, IDENTITY.md, MEMORY.md live in workspace ROOT
 *    (managed by ensureAgentIdentity in test mode; user-owned in prod).
 *  - CURRENT_LEAF.md / WORK_CONTEXT.md / RESULT_SCHEMA.md / TRELLIS_OPS.md
 *    live under workspace/.trellis/ — refreshed each leaf.
 *  - progress.json / result.json land in workspace/.trellis/ — agent
 *    writes them there; we read + archive after each session.
 */
export interface BootstrapResult {
  workspaceDir: string;
  briefDir: string;
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
  const briefDir = path.join(workspaceDir, TRELLIS_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(briefDir, { recursive: true });

  // Clear any leftover progress/result/envelope from the previous leaf.
  for (const stale of ["progress.json", "result.json", "envelope.json"]) {
    const p = path.join(briefDir, stale);
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

  // Brief files in workspace/.trellis/ — overwritten each leaf.
  // AGENTS.md / SOUL.md / IDENTITY.md / MEMORY.md remain at workspace
  // root (owned by ensureAgentIdentity in test mode; user-owned in prod).
  fs.writeFileSync(
    path.join(briefDir, "CURRENT_LEAF.md"),
    renderCurrentLeafMd(leaf, root),
  );
  fs.writeFileSync(path.join(briefDir, "WORK_CONTEXT.md"), contextMarkdown);
  fs.writeFileSync(
    path.join(briefDir, "RESULT_SCHEMA.md"),
    renderResultSchemaMd(),
  );
  // Operating-procedure file: written every session so prod-mode users
  // (whose AGENTS.md is their own) still get the Trellis-specific
  // sandbox + checkpoint + brief-file conventions.
  fs.writeFileSync(
    path.join(briefDir, "TRELLIS_OPS.md"),
    renderTrellisOpsMd(),
  );

  return { workspaceDir, briefDir, contextMarkdown };
}

function renderCurrentLeafMd(leaf: Node, root: Node | null): string {
  return `# Current leaf

> ${leaf.title}

${leaf.body || "_(no body — see WORK_CONTEXT.md for surrounding graph)_"}

${root ? `\nServes root purpose: **${root.title}**.\n` : ""}
Read \`TRELLIS_OPS.md\` (next to this file) for the Trellis-specific
operating procedure, \`WORK_CONTEXT.md\` for the surrounding graph, and
\`RESULT_SCHEMA.md\` for the file shapes to write. Then do the work and
either checkpoint via \`progress.json\` or finish with \`result.json\`
(both written to this same directory).
`;
}

function renderTrellisOpsMd(): string {
  return `# Trellis operating procedure

You're picking up a Trellis-tracked leaf. Trellis is a graph-native
task substrate; your job here is to take one leaf and turn it into
work products. Then write a structured result so Trellis can record
what happened.

## What you act on

You act on the **current leaf** (described in \`CURRENT_LEAF.md\` next
to this file). You're aware of the surrounding graph
(\`WORK_CONTEXT.md\`), but you don't unilaterally start work on
adjacent leaves — those get their own sessions. If you notice an
overlap, duplicate, or unblocking relationship, surface it in
\`notes\` so it lands in the graph for future picking.

## Sandbox boundary

All file writes happen inside this brief directory (\`.trellis/\`
inside the agent workspace) **or** in newly-created files within the
agent workspace. Read external files freely (project source, public
docs, references) using absolute paths, but don't write to them. If a
leaf seems to require modifying source elsewhere, copy into this
directory, edit the copy, and list the changes in
\`result.json.artifacts\` for human review.

## Checkpointing

For complex leaves you'll likely do meaningful work in chunks: read
the existing system, draft an approach, write code, run tests, refine.
After each significant chunk — every 5-10 minutes of focused work, or
after any milestone worth preserving — write \`progress.json\` next to
this file as a checkpoint.

\`progress.json\` uses the same schema as \`result.json\` (see
\`RESULT_SCHEMA.md\`) with \`status: "in_progress"\`. Captures
state-so-far, observations, dead ends, follow-ups identified, files
produced.

Treat it like a save file. Trellis reads it if your session ends
without a final \`result.json\`. Update it generously; rewriting the
same file is cheap.

When you genuinely finish (or hit a real blocker), write
\`result.json\` and stop. \`result.json\` supersedes any prior
\`progress.json\`.

## Subagents

Complex leaves with parallelizable sub-jobs (research X while drafting
Y, audit two files concurrently) can be done faster by spawning
subagents via the \`sessions_spawn\` tool. Each subagent gets its own
context. You collect their results and integrate.

Use them when work decomposes naturally; skip them when it's
fundamentally sequential.
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
