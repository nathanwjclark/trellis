import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { open } from "../graph/db.js";
import { Repo } from "../graph/repo.js";
import { EventBus } from "./events.js";
import { GraphManager } from "./graph_manager.js";
import { buildApp } from "./routes.js";

export interface ServerHandle {
  url: string;
  port: number;
  manager: GraphManager;
  close: () => Promise<void>;
}

/**
 * Boot the Hono server bound to 127.0.0.1:port. Returns a handle with
 * the resolved URL, the live GraphManager, and a graceful close. The
 * manager owns the live DB handle + event bus; the dashboard's graph-
 * picker can hot-swap to another graph through it without restarting
 * the HTTP server.
 */
export async function startServer(args: {
  /** Initial graph DB path (already validated to exist). */
  dbPath: string;
  /** Short name for the initial graph (e.g. "startup-ideation"). */
  graphName: string;
  /** Directory under which named graph DBs live. The manager scans
   *  this for the dropdown and writes the .active marker here. */
  graphsDir: string;
  port: number;
  hostname?: string;
  pollIntervalMs?: number;
  sessionsDir: string;
  logsDir: string;
  agentWorkspaceDir: string;
}): Promise<ServerHandle> {
  const pollIntervalMs = args.pollIntervalMs ?? 1000;
  const db = open({ path: args.dbPath });
  const repo = new Repo(db);
  const bus = new EventBus(repo, pollIntervalMs);
  bus.start();

  const manager = new GraphManager(
    { db, repo, bus, dbPath: args.dbPath, name: args.graphName },
    args.graphsDir,
    pollIntervalMs,
  );

  const app = buildApp({
    manager,
    sessionsDir: args.sessionsDir,
    logsDir: args.logsDir,
    agentWorkspaceDir: args.agentWorkspaceDir,
  });

  const hostname = args.hostname ?? "127.0.0.1";
  return await new Promise((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        port: args.port,
        hostname,
      },
      (info: AddressInfo) => {
        const url = `http://${hostname}:${info.port}`;
        resolve({
          url,
          port: info.port,
          manager,
          close: () =>
            new Promise<void>((res) => {
              manager.shutdown();
              server.close(() => res());
            }),
        });
      },
    );
  });
}
