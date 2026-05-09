import fs from "node:fs";
import path from "node:path";
import { open } from "../../graph/db.js";
import { loadConfig } from "../config.js";

const SNAP_SUBDIR = "data/snapshots";

function snapshotsDir(): string {
  const dir = path.resolve(SNAP_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function snapshotPath(name: string): string {
  if (!/^[a-zA-Z0-9_\-.]{1,80}$/.test(name)) {
    throw new Error(
      `invalid snapshot name "${name}". Use letters, digits, _ - . only.`,
    );
  }
  return path.join(snapshotsDir(), `${name}.db`);
}

export async function snapshotCmd(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const verbs = ["save", "restore", "list", "delete"].filter(
    (v) => flags[v] !== undefined,
  );
  if (verbs.length === 0) {
    throw new Error(
      "snapshot requires one of --save <name>, --restore <name>, --list, --delete <name>",
    );
  }
  if (verbs.length > 1) {
    throw new Error(`snapshot accepts only one of: ${verbs.join(", ")}`);
  }
  const verb = verbs[0]!;

  if (verb === "list") return list();
  if (verb === "save") return save(flags);
  if (verb === "restore") return restore(flags);
  if (verb === "delete") return remove(flags);
}

function list(): void {
  const dir = snapshotsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .sort();
  if (files.length === 0) {
    process.stdout.write("(no snapshots)\n");
    return;
  }
  process.stdout.write(
    `${"name".padEnd(30)} ${"size".padStart(8)}  modified\n`,
  );
  for (const f of files) {
    const p = path.join(dir, f);
    const stat = fs.statSync(p);
    const name = f.replace(/\.db$/, "");
    const size = `${(stat.size / 1024).toFixed(0)} KB`;
    process.stdout.write(
      `${name.padEnd(30)} ${size.padStart(8)}  ${stat.mtime.toISOString()}\n`,
    );
  }
}

async function save(flags: Record<string, string | boolean>): Promise<void> {
  if (typeof flags.save !== "string") {
    throw new Error("snapshot --save requires a name");
  }
  const cfg = loadConfig();
  const dest = snapshotPath(flags.save);
  if (fs.existsSync(dest) && flags.force !== true) {
    throw new Error(
      `snapshot ${flags.save} already exists at ${dest}. Pass --force to overwrite.`,
    );
  }

  // better-sqlite3's backup() uses SQLite's online backup API — safe even
  // when other processes have the source DB open.
  const db = open({ path: cfg.dbPath });
  try {
    await db.backup(dest);
    const stat = fs.statSync(dest);
    process.stdout.write(
      `✓ saved snapshot ${flags.save} (${(stat.size / 1024).toFixed(0)} KB)\n  ${dest}\n`,
    );
  } finally {
    db.close();
  }
}

function restore(flags: Record<string, string | boolean>): void {
  if (typeof flags.restore !== "string") {
    throw new Error("snapshot --restore requires a name");
  }
  const cfg = loadConfig();
  const src = snapshotPath(flags.restore);
  if (!fs.existsSync(src)) {
    throw new Error(`snapshot ${flags.restore} not found at ${src}`);
  }
  if (flags.yes !== true && flags.force !== true) {
    throw new Error(
      `restore overwrites ${cfg.dbPath}. This is destructive. Pass --yes to confirm.`,
    );
  }

  // Refuse if any other trellis process appears to be holding the DB open.
  // SQLite's WAL/SHM files persist when a writer is active.
  // (Best effort; we don't have a real lockfile yet.)
  if (fs.existsSync(`${cfg.dbPath}-wal`)) {
    const stat = fs.statSync(`${cfg.dbPath}-wal`);
    if (stat.size > 0 && flags.force !== true) {
      process.stderr.write(
        `warning: ${cfg.dbPath}-wal is non-empty — another trellis process may be writing.\n` +
          `  Stop it before --restore, or pass --force to override.\n`,
      );
      process.exit(1);
    }
  }

  // Wipe WAL/SHM so the restored DB doesn't try to merge stale state.
  for (const ext of ["", "-wal", "-shm"]) {
    const f = `${cfg.dbPath}${ext}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  fs.copyFileSync(src, cfg.dbPath);
  process.stdout.write(
    `✓ restored from snapshot ${flags.restore}\n  → ${cfg.dbPath}\n`,
  );
}

function remove(flags: Record<string, string | boolean>): void {
  if (typeof flags.delete !== "string") {
    throw new Error("snapshot --delete requires a name");
  }
  const f = snapshotPath(flags.delete);
  if (!fs.existsSync(f)) {
    throw new Error(`snapshot ${flags.delete} not found`);
  }
  fs.unlinkSync(f);
  process.stdout.write(`✓ deleted snapshot ${flags.delete}\n`);
}
