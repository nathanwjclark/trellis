import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Repo } from "../graph/repo.js";
import { EventBus } from "./events.js";
import { buildApp } from "./routes.js";

export interface ServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Boot the Hono server bound to 127.0.0.1:port. Returns a handle with the
 * resolved URL and a graceful close function.
 */
export async function startServer(args: {
  repo: Repo;
  port: number;
  hostname?: string;
  pollIntervalMs?: number;
  sessionsDir: string;
  logsDir: string;
}): Promise<ServerHandle> {
  const bus = new EventBus(args.repo, args.pollIntervalMs ?? 1000);
  bus.start();

  const app = buildApp({
    repo: args.repo,
    bus,
    sessionsDir: args.sessionsDir,
    logsDir: args.logsDir,
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
          close: () =>
            new Promise<void>((res) => {
              bus.stop();
              server.close(() => res());
            }),
        });
      },
    );
  });
}
