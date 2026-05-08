import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
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

  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  const handle = await startServer({
    repo,
    port,
    hostname,
    sessionsDir: cfg.sessionsDir,
    logsDir: cfg.logsDir,
  });

  process.stdout.write(`trellis monitoring server\n`);
  process.stdout.write(`  url:        ${handle.url}\n`);
  process.stdout.write(`  api:        ${handle.url}/api/graph\n`);
  process.stdout.write(`  events:     ${handle.url}/api/events/stream\n`);
  process.stdout.write(`  database:   ${cfg.dbPath}\n`);
  process.stdout.write(`  ctrl+c to stop\n`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${signal} received — shutting down\n`);
    await handle.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the event loop alive — the server already does this via the
  // listener, but be explicit so unref'd timers don't trick us into exiting.
  await new Promise(() => {});
}
