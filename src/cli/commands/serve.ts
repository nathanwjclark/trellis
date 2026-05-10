import fs from "node:fs";
import path from "node:path";
import { startServer } from "../../server/http.js";
import { loadConfig } from "../config.js";

export async function serveCmd(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const port =
    typeof flags["port"] === "string"
      ? Number.parseInt(flags["port"], 10)
      : cfg.port;
  const hostname =
    typeof flags["host"] === "string" ? flags["host"] : "127.0.0.1";

  // Make sure the graphs dir exists so the dashboard's list endpoint
  // can scan it; if the active graph DB is missing, surface a clear
  // error before starting up.
  fs.mkdirSync(cfg.graphsDir, { recursive: true });
  if (!fs.existsSync(cfg.dbPath)) {
    // If we ended up here via the legacy `data/trellis.db` default with
    // no real graph created yet, point the user at the migration step
    // instead of a confusing "schema mismatch" later.
    process.stderr.write(
      `error: active graph DB does not exist at ${cfg.dbPath}\n` +
        `       active graph: "${cfg.activeGraph}"\n` +
        `       graphs dir:   ${cfg.graphsDir}\n` +
        `Use \`trellis graph create <name>\` to start a new one,\n` +
        `or set TRELLIS_DB_PATH to an existing DB.\n`,
    );
    process.exit(2);
  }

  const handle = await startServer({
    dbPath: cfg.dbPath,
    graphName: cfg.activeGraph,
    graphsDir: cfg.graphsDir,
    port,
    hostname,
    sessionsDir: cfg.sessionsArchiveDir,
    logsDir: cfg.logsDir,
    agentWorkspaceDir: cfg.agentWorkspaceDir,
  });

  process.stdout.write(`trellis monitoring server\n`);
  process.stdout.write(`  url:        ${handle.url}\n`);
  process.stdout.write(`  api:        ${handle.url}/api/graph\n`);
  process.stdout.write(`  events:     ${handle.url}/api/events/stream\n`);
  process.stdout.write(`  graph:      ${cfg.activeGraph} (${cfg.dbPath})\n`);
  process.stdout.write(`  graphs dir: ${cfg.graphsDir}\n`);
  process.stdout.write(`  ctrl+c to stop\n`);
  // Touch path import so `path` doesn't get tree-shaken out if we add
  // path-based logging later.
  void path;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${signal} received — shutting down\n`);
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the event loop alive.
  await new Promise(() => {});
}
