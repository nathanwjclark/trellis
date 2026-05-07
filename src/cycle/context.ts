import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";
import { ancestors } from "../graph/traversal.js";

export interface AssembledContext {
  source: Node;
  /** Markdown-rendered context block to embed in the prompt. */
  markdown: string;
  /** UUIDs of nodes referenced in the markdown — useful for traceability. */
  referencedIds: string[];
}

/**
 * Assemble a markdown context block describing the existing graph slice the
 * LLM should consider when extrapolating against `sourceId`.
 *
 * Includes:
 *  - the source node itself
 *  - all ancestors via subtask_of + ladders_up_to (chain to root)
 *  - every root_purpose in the graph
 *  - up to N most-recently-touched strategy / rationale / concept nodes
 *
 * The model is instructed to reference any of these by uuid in its edges
 * rather than inventing duplicates.
 */
export function assembleContext(
  repo: Repo,
  sourceId: string,
  opts: { recencyLimit?: number } = {},
): AssembledContext {
  const recencyLimit = opts.recencyLimit ?? 30;
  const source = repo.getNode(sourceId);
  if (!source) throw new Error(`source node ${sourceId} not found`);

  const lines: string[] = [];
  const referenced = new Set<string>();

  lines.push(`### Source task`);
  lines.push(renderNode(source));
  referenced.add(source.id);

  const anc = ancestors(repo, sourceId);
  if (anc.length) {
    lines.push(`\n### Ancestors (chain up to root)`);
    for (const n of anc) {
      lines.push(renderNode(n));
      referenced.add(n.id);
    }
  }

  const roots = repo.listNodes({ type: "root_purpose" });
  const newRoots = roots.filter((r) => !referenced.has(r.id));
  if (newRoots.length) {
    lines.push(`\n### Other root purposes in this graph`);
    for (const r of newRoots) {
      lines.push(renderNode(r));
      referenced.add(r.id);
    }
  }

  const recents: Node[] = [];
  for (const t of ["strategy", "rationale", "concept"] as const) {
    for (const n of repo.listNodes({ type: t, limit: recencyLimit })) {
      if (!referenced.has(n.id)) {
        recents.push(n);
        referenced.add(n.id);
      }
    }
  }
  if (recents.length) {
    lines.push(`\n### Recently-touched related nodes`);
    for (const n of recents) {
      lines.push(renderNode(n));
    }
  }

  if (referenced.size === 1) {
    lines.push(
      `\n_(This is a fresh graph. There are no other nodes for you to reference.)_`,
    );
  }

  return {
    source,
    markdown: lines.join("\n"),
    referencedIds: [...referenced],
  };
}

function renderNode(n: Node): string {
  const head = `- **${n.type}** \`${n.id}\` — _${n.title}_`;
  const status =
    n.status !== "n/a" ? ` [${n.status}${n.task_kind ? `/${n.task_kind}` : ""}]` : "";
  const body = n.body.trim();
  const bodyLine = body
    ? `\n  ${body.slice(0, 400).replace(/\n+/g, " ")}${body.length > 400 ? "…" : ""}`
    : "";
  return `${head}${status}${bodyLine}`;
}
