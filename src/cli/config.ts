import path from "node:path";
import fs from "node:fs";

export type OpenclawMode = "test" | "prod";

export interface Config {
  dbPath: string;
  port: number;
  dailyUsdBudget: number;
  /** Absolute path to the openclaw checkout (containing openclaw.mjs). */
  openclawPath: string | null;
  /** Per-call ndjson log root. */
  logsDir: string;

  // ─── Agent identity (PR v0.4f) ──────────────────────────────────────
  /** Stable identity for the long-running Trellis agent. Default
   *  "trellis-default". Used to namespace persistent workspace, state,
   *  and openclaw session id. Override via TRELLIS_AGENT_IDENTITY. */
  agentIdentity: string;
  /** test mode (default) pre-fills SOUL.md / IDENTITY.md / AGENTS.md
   *  and sets agents.defaults.skipBootstrap=true so openclaw skips its
   *  interactive identity onboarding. prod mode trusts that openclaw
   *  has been onboarded and the identity files already exist. */
  openclawMode: OpenclawMode;
  /** Persistent per-identity workspace (cwd for openclaw subprocess).
   *  Holds SOUL.md, IDENTITY.md, AGENTS.md, MEMORY.md (memory plugins
   *  write here), plus the per-session brief files
   *  (CURRENT_LEAF.md, WORK_CONTEXT.md, RESULT_SCHEMA.md) which are
   *  overwritten on each leaf execution. */
  agentWorkspaceDir: string;
  /** Persistent per-identity OPENCLAW_STATE_DIR. Holds openclaw.json,
   *  openclaw's session histories, plugin state. Survives across leaves
   *  so memory plugins, skills, and conversation continuity work. */
  agentStateDir: string;
  /** Per-leaf-session archive: stdout/stderr logs, copies of result.json
   *  / progress.json. */
  sessionsArchiveDir: string;
}

export function loadConfig(): Config {
  const dbPath = process.env.TRELLIS_DB_PATH ?? path.resolve("data/trellis.db");

  const agentIdentity =
    process.env.TRELLIS_AGENT_IDENTITY ?? "trellis-default";
  const openclawMode: OpenclawMode =
    (process.env.TRELLIS_OPENCLAW_MODE as OpenclawMode | undefined) ?? "test";
  if (openclawMode !== "test" && openclawMode !== "prod") {
    throw new Error(
      `TRELLIS_OPENCLAW_MODE must be "test" or "prod", got "${process.env.TRELLIS_OPENCLAW_MODE}"`,
    );
  }

  const agentRoot =
    process.env.TRELLIS_AGENT_DIR ??
    path.resolve(`data/agents/${agentIdentity}`);

  // Each path can be overridden individually so prod users can point at
  // an existing openclaw setup (workspace + state in unrelated locations).
  const agentWorkspaceDir = process.env.TRELLIS_AGENT_WORKSPACE
    ? path.resolve(process.env.TRELLIS_AGENT_WORKSPACE)
    : path.resolve(agentRoot, "workspace");
  const agentStateDir = process.env.TRELLIS_AGENT_STATE_DIR
    ? path.resolve(process.env.TRELLIS_AGENT_STATE_DIR)
    : path.resolve(agentRoot, "state");
  const sessionsArchiveDir = process.env.TRELLIS_SESSIONS_ARCHIVE_DIR
    ? path.resolve(process.env.TRELLIS_SESSIONS_ARCHIVE_DIR)
    : path.resolve(agentRoot, "sessions");

  return {
    dbPath,
    port: Number.parseInt(process.env.TRELLIS_PORT ?? "18810", 10),
    dailyUsdBudget: Number.parseFloat(process.env.TRELLIS_DAILY_USD_BUDGET ?? "10"),
    openclawPath: process.env.OPENCLAW_PATH ?? null,
    logsDir: process.env.TRELLIS_LOG_DIR ?? path.resolve("data/logs"),

    agentIdentity,
    openclawMode,
    agentWorkspaceDir,
    agentStateDir,
    sessionsArchiveDir,
  };
}

/**
 * Trellis writes its transient brief files (CURRENT_LEAF.md,
 * WORK_CONTEXT.md, RESULT_SCHEMA.md, plus the agent's progress.json /
 * result.json) into a `.trellis/` subdir of the workspace. This keeps
 * the workspace root unpolluted — important in prod mode where the
 * workspace is user-owned and may have their own structure.
 */
export function trellisSubdir(cfg: Config): string {
  return path.join(cfg.agentWorkspaceDir, ".trellis");
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
