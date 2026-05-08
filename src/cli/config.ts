import path from "node:path";
import fs from "node:fs";

export interface Config {
  dbPath: string;
  port: number;
  dailyUsdBudget: number;
  /** Absolute path to the openclaw checkout (containing openclaw.mjs). */
  openclawPath: string | null;
  /** Where to keep per-session workspaces. */
  sessionsDir: string;
  /** Where openclaw's isolated state lives (one subdir per session). */
  openclawStateRoot: string;
  /** Per-call ndjson log root. */
  logsDir: string;
}

export function loadConfig(): Config {
  const dbPath = process.env.TRELLIS_DB_PATH ?? path.resolve("data/trellis.db");
  return {
    dbPath,
    port: Number.parseInt(process.env.TRELLIS_PORT ?? "18810", 10),
    dailyUsdBudget: Number.parseFloat(process.env.TRELLIS_DAILY_USD_BUDGET ?? "10"),
    openclawPath: process.env.OPENCLAW_PATH ?? null,
    sessionsDir:
      process.env.TRELLIS_SESSIONS_DIR ?? path.resolve("data/sessions"),
    openclawStateRoot:
      process.env.TRELLIS_OPENCLAW_STATE_DIR ??
      path.resolve("data/openclaw-state"),
    logsDir: process.env.TRELLIS_LOG_DIR ?? path.resolve("data/logs"),
  };
}

/** Resolve openclaw entry point. Throws with actionable message if not set. */
export function requireOpenclawEntry(cfg: Config): string {
  if (!cfg.openclawPath) {
    throw new Error(
      "OPENCLAW_PATH not set. Add it to .env (e.g. /Users/you/claude-projects/openclaw).",
    );
  }
  const entry = path.resolve(cfg.openclawPath, "openclaw.mjs");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `openclaw entry not found at ${entry}. Confirm OPENCLAW_PATH points at a working openclaw checkout.`,
    );
  }
  return entry;
}
