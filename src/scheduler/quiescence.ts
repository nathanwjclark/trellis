import fs from "node:fs";
import path from "node:path";
import type { Config } from "../cli/config.js";

/**
 * Chat-precedence: when a human is actively conversing with the agent
 * via the gateway, a Trellis-spawned subprocess of the same identity
 * would create memory-plugin write contention and confuse the agent.
 * Wait until the chat agent has been quiet for `windowMs` before
 * picking the next leaf.
 *
 * "Active chat" = any non-trellis-prefixed jsonl in
 * `<state>/agents/<chat_agent>/sessions/` modified within the window.
 *
 * Returns immediately if prod mode isn't configured to watch a chat
 * agent (env TRELLIS_CHAT_AGENT unset / "" / TRELLIS_OPENCLAW_MODE!=prod).
 */
export interface QuiescenceOptions {
  /** Min seconds the chat agent must be idle before we proceed. */
  windowMs?: number;
  /** Max seconds we'll wait before giving up and proceeding anyway. */
  maxWaitMs?: number;
  /** Polling interval. */
  pollMs?: number;
  /** Hook for progress logs. */
  onWait?: (waitedMs: number, lastActivityMs: number) => void;
  /** Override clock for tests. */
  now?: () => number;
  /** Sleep impl (override for tests). */
  sleep?: (ms: number) => Promise<void>;
}

export function chatAgentName(): string | null {
  const v = process.env.TRELLIS_CHAT_AGENT;
  if (v === undefined) return "main";
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function chatSessionsDir(cfg: Config): string | null {
  if (cfg.openclawMode !== "prod") return null;
  const agent = chatAgentName();
  if (!agent) return null;
  return path.join(cfg.agentStateDir, "agents", agent, "sessions");
}

/** Returns the most recent mtime (epoch ms) across non-trellis session
 *  files in the chat agent's sessions dir, or null if the dir doesn't
 *  exist or has no qualifying files. */
export function lastChatActivityMs(cfg: Config): number | null {
  const dir = chatSessionsDir(cfg);
  if (!dir) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let max = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    // Skip Trellis's own sessions and openclaw's per-session index.
    if (ent.name.startsWith("trellis-")) continue;
    if (ent.name === "sessions.json") continue;
    if (!ent.name.endsWith(".jsonl")) continue;
    try {
      const st = fs.statSync(path.join(dir, ent.name));
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {
      /* skip */
    }
  }
  return max === 0 ? null : max;
}

export async function waitForChatQuiescence(
  cfg: Config,
  opts: QuiescenceOptions = {},
): Promise<{ waited: boolean; waitedMs: number; reason: string }> {
  const dir = chatSessionsDir(cfg);
  if (!dir) {
    return { waited: false, waitedMs: 0, reason: "no chat agent configured" };
  }
  const windowMs = opts.windowMs ?? 5 * 60 * 1000;
  const maxWaitMs = opts.maxWaitMs ?? 30 * 60 * 1000;
  const pollMs = opts.pollMs ?? 15 * 1000;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const start = now();
  let waited = false;
  while (true) {
    const last = lastChatActivityMs(cfg);
    if (last === null) {
      return {
        waited,
        waitedMs: now() - start,
        reason: "no chat sessions present",
      };
    }
    const idleMs = now() - last;
    if (idleMs >= windowMs) {
      return {
        waited,
        waitedMs: now() - start,
        reason: `chat idle ${Math.round(idleMs / 1000)}s ≥ ${Math.round(windowMs / 1000)}s window`,
      };
    }
    const elapsed = now() - start;
    if (elapsed >= maxWaitMs) {
      return {
        waited: true,
        waitedMs: elapsed,
        reason: `gave up after ${Math.round(elapsed / 1000)}s (chat still active)`,
      };
    }
    waited = true;
    opts.onWait?.(elapsed, last);
    await sleep(pollMs);
  }
}
