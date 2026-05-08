import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { descendants } from "../../graph/traversal.js";
import { loadConfig } from "../config.js";

/* ── Data types for JSON output ── */

export interface SummaryData {
  type_counts: Record<string, number>;
  root_purposes: { id: string; title: string; status: string }[];
  recent_events: { timestamp: string; type: string }[];
}

export interface TreeData {
  root: { id: string; type: string; title: string; status: string };
  descendants: { id: string; type: string; title: string; status: string }[];
}

/* ── Data-gathering (testable, no stdout) ── */

export function gatherSummary(repo: Repo): SummaryData {
  const counts: Record<string, number> = {};
  for (const n of repo.listNodes()) {
    counts[n.type] = (counts[n.type] ?? 0) + 1;
  }

  const roots = repo.listNodes({ type: "root_purpose" }).map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
  }));

  const events = repo.recentEvents(10).map((e) => ({
    timestamp: new Date(e.created_at).toISOString(),
    type: e.type,
  }));

  return { type_counts: counts, root_purposes: roots, recent_events: events };
}

export function gatherTree(
  repo: Repo,
  rootId: string,
): TreeData | null {
  const root = repo.getNode(rootId);
  if (!root) return null;

  const desc = descendants(repo, rootId).map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    status: n.status,
  }));

  return {
    root: { id: root.id, type: root.type, title: root.title, status: root.status },
    descendants: desc,
  };
}

/* ── Rendering (human-readable) ── */

function renderSummary(data: SummaryData): void {
  process.stdout.write(`nodes by type:\n`);
  const types = Object.keys(data.type_counts).sort();
  if (types.length === 0) process.stdout.write("  (empty)\n");
  for (const t of types)
    process.stdout.write(`  ${t.padEnd(14)} ${data.type_counts[t]}\n`);

  if (data.root_purposes.length) {
    process.stdout.write(`\nroot purposes:\n`);
    for (const r of data.root_purposes) {
      process.stdout.write(`  ${r.id}  [${r.status}]  ${r.title}\n`);
    }
  }

  if (data.recent_events.length) {
    process.stdout.write(`\nrecent events:\n`);
    for (const e of data.recent_events) {
      process.stdout.write(`  ${e.timestamp}  ${e.type}\n`);
    }
  }
}

function renderTree(data: TreeData): void {
  process.stdout.write(
    `${data.root.type}  ${data.root.title}  [${data.root.status}]\n`,
  );
  if (data.descendants.length === 0) {
    process.stdout.write("  (no descendants)\n");
  } else {
    for (const n of data.descendants) {
      process.stdout.write(`  - ${n.type}  ${n.title}  [${n.status}]\n`);
    }
  }
}

/* ── Entry point ── */

export async function status(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);
  const json = flags.json === true;

  try {
    if (typeof flags.tree === "string") {
      const data = gatherTree(repo, flags.tree);
      if (!data) {
        process.stderr.write(`node ${flags.tree} not found\n`);
        process.exit(1);
      }
      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      } else {
        renderTree(data);
      }
    } else {
      const data = gatherSummary(repo);
      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      } else {
        renderSummary(data);
      }
    }
  } finally {
    db.close();
  }
}
