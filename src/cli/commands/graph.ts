import fs from "node:fs";
import path from "node:path";
import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { loadConfig } from "../config.js";

/**
 * `trellis graph` — manage multiple independent graphs.
 *
 * Each graph is an isolated SQLite file under `<graphsDir>/<name>.db`.
 * A marker file at `<graphsDir>/.active` records which graph is the
 * default for operations that don't have TRELLIS_DB_PATH explicitly
 * set. Cass's openclaw identity (workspace, MEMORY, skills, persona)
 * is intentionally *not* duplicated per graph — she's one agent who
 * works on multiple projects.
 *
 * Subcommands:
 *   trellis graph list                  — list graphs, mark the active one
 *   trellis graph create <name>         — create + initialize a fresh DB
 *   trellis graph activate <name>       — write the marker file
 *   trellis graph current               — print active graph + counts
 */
export async function graph(
  positional: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const sub = positional[0] ?? "current";
  const cfg = loadConfig();

  // Make sure the graphs dir exists (graph subcommands may be the
  // first time anything touches it).
  fs.mkdirSync(cfg.graphsDir, { recursive: true });

  switch (sub) {
    case "list":
      return listGraphs(cfg.graphsDir);
    case "create":
      return createGraph(cfg.graphsDir, requireName(positional[1]));
    case "activate":
      return activateGraph(cfg.graphsDir, requireName(positional[1]));
    case "current":
      return printCurrent();
    default:
      throw new Error(
        `unknown graph subcommand "${sub}". Use list / create / activate / current.`,
      );
  }
}

function requireName(s: string | undefined): string {
  if (!s) throw new Error("graph name required");
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    throw new Error(
      `graph name "${s}" must match [a-zA-Z0-9._-]+; no slashes or spaces`,
    );
  }
  return s;
}

function listGraphs(graphsDir: string): void {
  const active = readActive(graphsDir);
  const entries = readGraphFiles(graphsDir);
  if (entries.length === 0) {
    process.stdout.write(
      `no graphs found in ${graphsDir}. Use \`trellis graph create <name>\` to start.\n`,
    );
    return;
  }
  for (const e of entries) {
    const marker = e.name === active ? "*" : " ";
    const sz = humanSize(e.size);
    const stamp = new Date(e.mtime).toISOString().slice(0, 19).replace("T", " ");
    process.stdout.write(
      `${marker} ${e.name.padEnd(28)}  ${sz.padStart(8)}  ${stamp}\n`,
    );
  }
  if (active && !entries.find((e) => e.name === active)) {
    process.stdout.write(
      `\n  warning: active marker is "${active}" but no DB at that name exists\n`,
    );
  }
}

function createGraph(graphsDir: string, name: string): void {
  const target = path.join(graphsDir, `${name}.db`);
  if (fs.existsSync(target)) {
    throw new Error(`graph "${name}" already exists at ${target}`);
  }
  // Use the same open() helper that runs migrations on first connection,
  // then close so the file is ready to be reopened by other commands.
  const db = open({ path: target });
  // Sanity-check schema is in place.
  new Repo(db);
  db.close();
  process.stdout.write(`created graph "${name}" at ${target}\n`);
  process.stdout.write(
    `\nNext steps:\n  trellis graph activate ${name}\n  trellis ingest --root "<your root_purpose>"\n  trellis cycle --node <root-id>\n`,
  );
}

function activateGraph(graphsDir: string, name: string): void {
  const target = path.join(graphsDir, `${name}.db`);
  if (!fs.existsSync(target)) {
    throw new Error(
      `cannot activate "${name}": no DB at ${target}. Use \`trellis graph create ${name}\` first.`,
    );
  }
  fs.writeFileSync(path.join(graphsDir, ".active"), name + "\n");
  process.stdout.write(
    `active graph is now "${name}" (${target}).\nRestart trellis-loop / trellis-serve for them to pick up the change.\n`,
  );
}

function printCurrent(): void {
  // Re-load config so we reflect what other commands actually see (the
  // marker file might have been changed since this process started).
  const cfg = loadConfig();
  const exists = fs.existsSync(cfg.dbPath);
  process.stdout.write(`active graph: ${cfg.activeGraph}\n`);
  process.stdout.write(`db path:      ${cfg.dbPath}\n`);
  if (!exists) {
    process.stdout.write(`status:       missing — file does not exist\n`);
    return;
  }
  // Open it briefly to read counts.
  const db = open({ path: cfg.dbPath });
  try {
    const repo = new Repo(db);
    const nodes = repo.listNodes();
    const byStatus: Record<string, number> = {};
    for (const n of nodes) {
      byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
    }
    const roots = nodes
      .filter((n) => n.type === "root_purpose")
      .map((n) => `${n.title} (${n.status})`);
    const sz = humanSize(safeSize(cfg.dbPath));
    process.stdout.write(`size:         ${sz}\n`);
    process.stdout.write(`nodes:        ${nodes.length}\n`);
    process.stdout.write(
      `by status:    ${Object.entries(byStatus)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}\n`,
    );
    if (roots.length === 0) {
      process.stdout.write(
        `roots:        (none — ingest one with \`trellis ingest --root "..."\`)\n`,
      );
    } else {
      process.stdout.write(`roots:\n`);
      for (const r of roots) process.stdout.write(`  - ${r}\n`);
    }
  } finally {
    db.close();
  }
}

function readActive(graphsDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(graphsDir, ".active"), "utf8").trim();
    if (raw && /^[a-zA-Z0-9._-]+$/.test(raw)) return raw;
  } catch {
    /* none */
  }
  return null;
}

function readGraphFiles(graphsDir: string): {
  name: string;
  size: number;
  mtime: number;
}[] {
  let names: string[];
  try {
    names = fs.readdirSync(graphsDir);
  } catch {
    return [];
  }
  const out: { name: string; size: number; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".db")) continue;
    const full = path.join(graphsDir, n);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({
        name: n.replace(/\.db$/, ""),
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
