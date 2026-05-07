import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { descendants } from "../../graph/traversal.js";
import { loadConfig } from "../config.js";

export async function status(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  if (typeof flags.tree === "string") {
    printTree(repo, flags.tree);
  } else {
    printSummary(repo);
  }
  db.close();
}

function printSummary(repo: Repo): void {
  const counts: Record<string, number> = {};
  for (const n of repo.listNodes()) {
    counts[n.type] = (counts[n.type] ?? 0) + 1;
  }
  process.stdout.write(`nodes by type:\n`);
  const types = Object.keys(counts).sort();
  if (types.length === 0) process.stdout.write("  (empty)\n");
  for (const t of types) process.stdout.write(`  ${t.padEnd(14)} ${counts[t]}\n`);

  const roots = repo.listNodes({ type: "root_purpose" });
  if (roots.length) {
    process.stdout.write(`\nroot purposes:\n`);
    for (const r of roots) {
      process.stdout.write(`  ${r.id}  [${r.status}]  ${r.title}\n`);
    }
  }

  const ev = repo.recentEvents(10);
  if (ev.length) {
    process.stdout.write(`\nrecent events:\n`);
    for (const e of ev) {
      const when = new Date(e.created_at).toISOString();
      process.stdout.write(`  ${when}  ${e.type}\n`);
    }
  }
}

function printTree(repo: Repo, rootId: string): void {
  const root = repo.getNode(rootId);
  if (!root) {
    process.stderr.write(`node ${rootId} not found\n`);
    process.exit(1);
  }
  process.stdout.write(`${root.type}  ${root.title}  [${root.status}]\n`);
  const desc = descendants(repo, rootId);
  for (const n of desc) {
    process.stdout.write(`  - ${n.type}  ${n.title}  [${n.status}]\n`);
  }
  if (desc.length === 0) process.stdout.write("  (no descendants)\n");
}
