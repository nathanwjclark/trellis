import fs from "node:fs";
import path from "node:path";
import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";
import { ancestors } from "../graph/traversal.js";

/**
 * Build the per-session workspace OpenClaw will run in. Produces:
 *  - AGENTS.md  — persona framing the agent as a Trellis worker on this leaf
 *  - WORK_CONTEXT.md — leaf body + subgraph context for orientation
 *  - RESULT_SCHEMA.md — schema the agent must follow when writing result.json
 *  - .gitkeep so the dir is committed if the user version-controls sessions
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
    sessionsDir: string;
    sessionId: string;
    leafId: string;
    rootPurposeId?: string | null;
  },
): BootstrapResult {
  const workspaceDir = path.resolve(args.sessionsDir, args.sessionId);
  fs.mkdirSync(workspaceDir, { recursive: true });

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

  const contextMarkdown = renderContext({
    leaf,
    root,
    parent,
    ancestors: ancestorsList,
    siblings: siblings.slice(0, 8),
    risks: [...risksOnLeaf, ...risksOnParent].slice(0, 6),
    rationale: [...rationaleOnLeaf, ...rationaleOnParent].slice(0, 6),
    priorSummary: priorSessionSummary(leaf),
  });

  fs.writeFileSync(
    path.join(workspaceDir, "AGENTS.md"),
    renderAgentsMd(leaf, root),
  );
  fs.writeFileSync(path.join(workspaceDir, "WORK_CONTEXT.md"), contextMarkdown);
  fs.writeFileSync(
    path.join(workspaceDir, "RESULT_SCHEMA.md"),
    renderResultSchemaMd(),
  );

  return { workspaceDir, contextMarkdown };
}

function renderAgentsMd(leaf: Node, root: Node | null): string {
  return `# Agent persona — Trellis worker

You're a worker on a Trellis graph project. Trellis is the persistent
mind: it stores tasks, subtasks, risks, rationale, strategies, and
relationships between them as a graph. You are the engine that takes
one leaf at a time and turns it into work products.

**Your current leaf**:

> ${leaf.title}

You have full context on the surrounding graph (parent, ancestor chain,
sibling tasks, known risks, supporting rationale, prior session progress
if any). Use it freely. If you notice that another open task overlaps,
duplicates this one, or blocks/unblocks it, surface that observation in
\`notes\` so the next session or a human can act on it. Connecting work
across the graph is more valuable than tunnel-vision focus.

**What you act on, though, is this leaf.** Don't start work on adjacent
leaves; that's not your scope this session. Your action authority is one
leaf at a time, even though your awareness is broader. Other leaves get
their own sessions.

${root ? `Your work serves the root purpose: **${root.title}**.\n` : ""}
## ⚠️ Sandbox boundary

**All file writes happen inside this workspace directory** (your current
working directory). This is your sandbox. Code you produce here is
persistent — Trellis tracks it as an artifact attached to the leaf — but
it does not blend with any wider project tree.

You **may read** files outside the workspace (Trellis source under the
project root, public docs, references) using absolute paths.

You **may not write or edit** files outside the workspace. If the leaf
appears to require modifying source elsewhere (e.g. "add a flag to a CLI
command"), instead:

1. Make a copy of the relevant file(s) in the workspace and edit the copy,
   OR write a unified diff / patch as a workspace artifact.
2. List the changed files (relative to project root) and the
   workspace-relative artifact paths in \`result.json\` under \`artifacts\`
   plus a note describing what should be promoted.
3. Trellis (or the human operator) will review and promote the changes
   into the real tree explicitly. You don't do that yourself.

This sandbox boundary keeps experimentation safe, makes review tractable,
and prevents the agent's working files from blending into a real
project's source. It is enforced by convention; behave accordingly.

## How you work

1. Read \`WORK_CONTEXT.md\` for the leaf body, parent task, ancestors,
   sibling tasks, known risks, and the rationale behind the work.
2. Read \`RESULT_SCHEMA.md\` for the JSON shape \`progress.json\` and
   \`result.json\` follow.
3. Do the work in this workspace — write code, run commands, edit files
   you've placed here. Reading external files is fine; modifying them is
   not.
4. **Checkpoint as you go**: for any leaf that takes more than a few
   minutes of focused work, update \`progress.json\` periodically so
   nothing is lost. See "Checkpointing your work" below.
5. When you genuinely finish (or hit a real blocker), write
   \`result.json\` and stop.

## 💾 Checkpointing your work

For complex leaves you'll likely do meaningful work in chunks: read the
existing system, draft an approach, write code, run tests, refine. After
each significant chunk — every 5-10 minutes of focused work, or after
any milestone worth preserving — write \`progress.json\` in this
workspace as a checkpoint.

\`progress.json\` uses the same schema as \`result.json\` (see
\`RESULT_SCHEMA.md\`) with one change: \`status\` is \`"in_progress"\`.
It captures:

- \`summary\` — what's been accomplished so far, in your own words
- \`notes\` — observations, dead ends, decisions that aren't obvious
  from the artifacts you produced
- \`new_tasks\` — concrete follow-ups you've identified
- \`artifacts\` — files you've produced in the workspace so far

Treat it like a save file. Trellis reads it if your run ends without a
final result.json, so partial work persists into the graph instead of
being lost. Update it generously; rewriting the same file is cheap.

## 🌿 Subagents (for parallelizable work)

Complex leaves with multiple independent sub-jobs (research X while
drafting Y, audit two files in parallel, etc.) can be done faster by
spawning subagents via the \`sessions_spawn\` tool. Each subagent gets
its own context and can work concurrently with you. You collect their
results and integrate them into your own \`progress.json\` /
\`result.json\`.

Use them when the work decomposes naturally; skip them when it's
fundamentally sequential.

## Stopping conditions

- **done** — you finished the leaf. Summary should say what success
  looks like and where the artifacts live.
- **blocked** — you cannot finish without external input. \`blocker\`
  field should explain what's missing.
- **needs_decomposition** — the leaf turned out to be bigger than one
  session of work. \`new_tasks\` should propose subtasks that, if
  finished, would complete this leaf.
- **cancelled** — the leaf is no longer worth doing (e.g. obviated by
  recent context). Explain in \`summary\`.

## Tone

Direct, opinionated, concrete. The graph has the philosophy; your job
is to ship work products. When in doubt, prefer doing over discussing.
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

function renderContext(args: {
  leaf: Node;
  root: Node | null;
  parent: Node | null;
  ancestors: Node[];
  siblings: Node[];
  risks: Node[];
  rationale: Node[];
  priorSummary: string | null;
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
    lines.push(`\n## Known risks\n`);
    for (const n of args.risks) {
      lines.push(`- **${n.title}**`);
      if (n.body) lines.push(`  ${n.body.slice(0, 400)}`);
    }
  }

  return lines.join("\n");
}
