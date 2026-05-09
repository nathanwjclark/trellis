import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { loadConfig } from "../config.js";

/**
 * Wipes graph state. Currently only supports --extrapolations which deletes
 * every node except root_purpose. Edge cascades + embedding cascades handle
 * the rest. Sessions table is also cleared.
 *
 * Designed for test workflows: snapshot first, then reset, then iterate on
 * extrapolation prompts and re-run cycle phases against a clean slate.
 */
export async function resetCmd(
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (flags.extrapolations !== true) {
    throw new Error(
      "reset requires --extrapolations (more flags may be added later). Pass --yes to confirm.",
    );
  }
  if (flags.yes !== true) {
    throw new Error(
      "reset is destructive. Pass --yes to confirm. Will delete every non-root_purpose node.",
    );
  }

  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  // Count what's about to go.
  const before = (
    db
      .prepare(
        "SELECT type, COUNT(*) AS c FROM nodes WHERE type != 'root_purpose' GROUP BY type",
      )
      .all() as { type: string; c: number }[]
  ).reduce<Record<string, number>>((acc, r) => {
    acc[r.type] = r.c;
    return acc;
  }, {});

  const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);
  const rootsKept = (
    db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE type='root_purpose'").get() as {
      c: number;
    }
  ).c;

  repo.tx(() => {
    // FK cascades on edges + embeddings handle automatically.
    db.prepare("DELETE FROM nodes WHERE type != 'root_purpose'").run();
    // Sessions reference nodes — surviving sessions would be dangling pointers.
    db.prepare("DELETE FROM sessions").run();
    repo.recordEvent({
      type: "node_archived",
      payload: {
        reason: "reset --extrapolations",
        deleted: totalBefore,
        breakdown: before,
      },
    });
  });

  process.stdout.write(`✓ reset complete\n`);
  process.stdout.write(`  deleted ${totalBefore} non-root_purpose nodes\n`);
  for (const [type, count] of Object.entries(before).sort()) {
    process.stdout.write(`    ${type.padEnd(14)} ${count}\n`);
  }
  process.stdout.write(`  root_purpose nodes kept: ${rootsKept}\n`);

  db.close();
}
