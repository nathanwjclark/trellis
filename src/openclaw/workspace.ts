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
  });

  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), renderAgentsMd(leaf, root));
  fs.writeFileSync(path.join(workspaceDir, "WORK_CONTEXT.md"), contextMarkdown);
  fs.writeFileSync(
    path.join(workspaceDir, "RESULT_SCHEMA.md"),
    renderResultSchemaMd(),
  );

  return { workspaceDir, contextMarkdown };
}

function renderAgentsMd(leaf: Node, root: Node | null): string {
  return `# Agent persona — Trellis worker

You are a focused worker assigned a single atomic task from the Trellis
graph (Trellis is the agent-mind substrate; you are the engine that
executes one of its leaves). Your job is **only** this leaf:

> ${leaf.title}

You do **not** plan further or extrapolate the broader graph; another
process did that. You execute.

${root ? `Your work serves the root purpose: **${root.title}**.\n` : ""}
## How you work

1. Read \`WORK_CONTEXT.md\` for the leaf body, parent task, ancestors,
   sibling tasks, known risks, and the rationale behind the work.
2. Read \`RESULT_SCHEMA.md\` for the JSON shape you must write at the end.
3. Do the work — write code, run commands, edit files, anything you need.
   This workspace is yours; files you produce here are persistent
   artifacts that Trellis can attach to the leaf.
4. When you are done (or blocked), write \`result.json\` in this
   workspace following \`RESULT_SCHEMA.md\` exactly, then stop.

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
  return `# result.json schema

Write this file in the current working directory at the end of your
session. Trellis reads it, validates it, and applies the result to the
graph.

\`\`\`json
{
  "status": "done | blocked | needs_decomposition | cancelled",
  "summary": "One paragraph describing what you actually did, what works, what's left.",
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

function renderContext(args: {
  leaf: Node;
  root: Node | null;
  parent: Node | null;
  ancestors: Node[];
  siblings: Node[];
  risks: Node[];
  rationale: Node[];
}): string {
  const lines: string[] = [];
  lines.push(`# Work context for: ${args.leaf.title}\n`);
  lines.push(`## Leaf task (the thing you're doing)\n`);
  lines.push(`**${args.leaf.title}**`);
  lines.push("");
  lines.push(args.leaf.body || "_(no body)_");

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
