import fs from "node:fs";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../graph/db.js";
import { Repo } from "../graph/repo.js";
import { EventBus } from "./events.js";

/**
 * Holds the currently-mounted graph for the running server, and lets
 * callers swap to a different one on the fly. The dashboard's graph-
 * picker hits an endpoint that calls switchTo() — repo + bus get
 * recreated against the new DB without restarting the HTTP server.
 *
 * Routes pull `manager.state.repo` and `manager.state.bus` per-request
 * rather than capturing them at construction; that way swaps are
 * picked up automatically by every endpoint.
 */
export interface GraphState {
  db: DB;
  repo: Repo;
  bus: EventBus;
  dbPath: string;
  name: string;
}

export class GraphManager {
  state: GraphState;
  private readonly graphsDir: string;
  private readonly pollIntervalMs: number;

  constructor(initial: GraphState, graphsDir: string, pollIntervalMs: number) {
    this.state = initial;
    this.graphsDir = graphsDir;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** List `<name>.db` files in the graphs dir. */
  list(): { name: string; size: number; mtime: number; active: boolean }[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.graphsDir);
    } catch {
      return [];
    }
    const out: { name: string; size: number; mtime: number; active: boolean }[] =
      [];
    for (const e of entries) {
      if (!e.endsWith(".db")) continue;
      const full = path.join(this.graphsDir, e);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const name = e.replace(/\.db$/, "");
        out.push({
          name,
          size: st.size,
          mtime: st.mtimeMs,
          active: name === this.state.name,
        });
      } catch {
        /* skip */
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Swap the live graph. Closes the old DB, opens the new one,
   *  rebuilds repo + bus, and updates the marker file so future
   *  process restarts pick up the same selection. */
  switchTo(name: string): GraphState {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(
        `graph name "${name}" must match [a-zA-Z0-9._-]+; no slashes or spaces`,
      );
    }
    const target = path.join(this.graphsDir, `${name}.db`);
    if (!fs.existsSync(target)) {
      throw new Error(`graph "${name}" does not exist (no DB at ${target})`);
    }
    if (name === this.state.name) {
      return this.state; // no-op
    }

    // Tear down the old.
    this.state.bus.stop();
    close(this.state.db);

    // Bring up the new.
    const db = open({ path: target });
    const repo = new Repo(db);
    const bus = new EventBus(repo, this.pollIntervalMs);
    bus.start();
    this.state = { db, repo, bus, dbPath: target, name };

    // Persist the selection to the marker file so trellis-loop / other
    // restarts agree with what the dashboard chose.
    try {
      fs.writeFileSync(path.join(this.graphsDir, ".active"), name + "\n");
    } catch (e) {
      // Non-fatal; the swap still happened in-memory. Log on stderr.
      process.stderr.write(
        `warning: could not update active marker: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }

    return this.state;
  }

  shutdown(): void {
    this.state.bus.stop();
    close(this.state.db);
  }
}
