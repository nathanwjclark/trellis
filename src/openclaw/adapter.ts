import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { OpenclawEnvelope, ExecutionResult } from "./types.js";
import type { Config } from "../cli/config.js";
import { requireOpenclawEntry, trellisSubdir } from "../cli/config.js";

export interface AdapterRunOptions {
  cfg: Config;
  /** Per-leaf-session id. Used for the per-session log archive only —
   *  the openclaw subprocess uses a stable session id derived from
   *  cfg.agentIdentity for cross-leaf conversation continuity. */
  sessionId: string;
  /** Persistent agent workspace (cwd). Owned by ensureAgentIdentity;
   *  contains SOUL.md / IDENTITY.md / AGENTS.md (persistent) plus the
   *  per-leaf brief files (CURRENT_LEAF.md / WORK_CONTEXT.md /
   *  RESULT_SCHEMA.md) that bootstrapWorkspace just refreshed. */
  workspaceDir: string;
  /** User message handed to openclaw. Often a one-line "do the leaf" prompt. */
  message: string;
  /** Override openclaw's --thinking flag. Default "medium". */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  /** Hard subprocess timeout in seconds. Default 1800 (30 min). */
  timeoutSeconds?: number;
  /** Streaming progress hook fired on every stdout / stderr line. */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface AdapterRunResult {
  ok: boolean;
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
  envelopePath: string | null;
  resultJsonPath: string | null;
  /** Parsed openclaw --json envelope, or null if it didn't produce one. */
  envelope: OpenclawEnvelope | null;
  /** Parsed result. Either the agent's final result.json or a partial
   *  progress.json checkpoint (when result.json was never written). */
  result: ExecutionResult | null;
  /** Where this result came from. "result" = final verdict in result.json.
   *  "progress" = recovered checkpoint from progress.json (the agent didn't
   *  finish — typically because the runtime cut it off before result.json
   *  got written). null = neither file was usable. */
  resultSource: "result" | "progress" | null;
  /** Validation issues with the result file if any. */
  resultIssues: string[];
  durationMs: number;
}

/**
 * Spawn `openclaw agent --local --json` against an isolated state dir +
 * pre-bootstrapped workspace. Captures stdout/stderr to per-session log
 * files so failures can be inspected after the fact.
 *
 * The agent is told (via AGENTS.md) to write `result.json` in its CWD.
 * We read that file when the subprocess exits and validate against the
 * ExecutionResult schema.
 */
export async function runAgent(opts: AdapterRunOptions): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const entry = requireOpenclawEntry(opts.cfg);

  // Per-leaf-session log archive (stdout/stderr persist here even though
  // workspace artifacts get overwritten on the next leaf).
  const archiveDir = path.resolve(opts.cfg.sessionsArchiveDir, opts.sessionId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const stdoutPath = path.join(archiveDir, "openclaw.stdout.log");
  const stderrPath = path.join(archiveDir, "openclaw.stderr.log");
  const stdoutFh = fs.openSync(stdoutPath, "w");
  const stderrFh = fs.openSync(stderrPath, "w");

  // Stable openclaw session id — same across every Trellis leaf for this
  // identity. Gives openclaw conversation continuity and lets memory
  // plugins accumulate knowledge across leaves.
  const openclawSessionId = `trellis-${opts.cfg.agentIdentity}`;

  const args = [
    entry,
    "agent",
    "--local",
    "--json",
    "--session-id",
    openclawSessionId,
    "--message",
    opts.message,
    "--thinking",
    opts.thinking ?? "medium",
    "--timeout",
    String(opts.timeoutSeconds ?? 1800),
  ];

  // Shared OPENCLAW_STATE_DIR per identity. openclaw config + plugin
  // state + session histories all live here and persist across leaves.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: opts.cfg.agentStateDir,
  };

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn("node", args, {
      cwd: opts.workspaceDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      fs.writeSync(stdoutFh, s);
      stdoutBuf += s;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        opts.onLine?.("stdout", line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      fs.writeSync(stderrFh, s);
      stderrBuf += s;
      let nl: number;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        opts.onLine?.("stderr", line);
      }
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? -1));
  });

  fs.closeSync(stdoutFh);
  fs.closeSync(stderrFh);

  // Parse the openclaw --json envelope from stdout. The envelope is a single
  // JSON document at the end of stdout; some openclaw versions sprinkle
  // banner lines before it. Find the last balanced JSON object.
  const stdoutText = fs.readFileSync(stdoutPath, "utf8");
  let envelope: OpenclawEnvelope | null = null;
  let envelopePath: string | null = null;
  const parsedEnvelope = extractTrailingJson(stdoutText);
  if (parsedEnvelope) {
    const safe = OpenclawEnvelope.safeParse(parsedEnvelope);
    if (safe.success) {
      envelope = safe.data;
      // Write directly into the archive — the workspace is shared
      // across leaves, so persisting here keeps per-session history clean.
      envelopePath = path.join(archiveDir, "envelope.json");
      fs.writeFileSync(envelopePath, JSON.stringify(parsedEnvelope, null, 2));
    }
  }

  // Prefer result.json; fall back to progress.json (the most recent
  // checkpoint the agent wrote). This lets long-running work survive a
  // hard subprocess kill: the agent's last checkpoint becomes the partial
  // result instead of being lost entirely.
  const briefDir = trellisSubdir(opts.cfg);
  const resultJsonPath = path.join(briefDir, "result.json");
  const progressJsonPath = path.join(briefDir, "progress.json");
  let result: ExecutionResult | null = null;
  let resultSource: "result" | "progress" | null = null;
  const resultIssues: string[] = [];

  const tryParse = (p: string): ExecutionResult | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const safe = ExecutionResult.safeParse(raw);
      if (safe.success) return safe.data;
      for (const issue of safe.error.issues) {
        resultIssues.push(`${path.basename(p)}: ${issue.path.join(".")}: ${issue.message}`);
      }
    } catch (err) {
      resultIssues.push(
        `${path.basename(p)}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  };

  if (fs.existsSync(resultJsonPath)) {
    result = tryParse(resultJsonPath);
    if (result) resultSource = "result";
  }
  if (!result && fs.existsSync(progressJsonPath)) {
    result = tryParse(progressJsonPath);
    if (result) resultSource = "progress";
  }
  if (!result) {
    resultIssues.push(
      "neither result.json nor progress.json was usable",
    );
  }

  // Archive per-leaf artifacts (snapshot the brief dir's leaf-specific
  // files into the per-session dir for postmortem) so the next leaf can
  // overwrite the brief dir freely.
  for (const f of [
    "result.json",
    "progress.json",
    "CURRENT_LEAF.md",
    "WORK_CONTEXT.md",
    "TRELLIS_OPS.md",
  ]) {
    const src = path.join(briefDir, f);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, path.join(archiveDir, f));
    } catch {
      // ignore archive failures — primary path already worked
    }
  }

  return {
    ok: exitCode === 0 && resultSource === "result",
    exitCode,
    stdoutPath,
    stderrPath,
    envelopePath,
    resultJsonPath: fs.existsSync(resultJsonPath)
      ? resultJsonPath
      : fs.existsSync(progressJsonPath)
        ? progressJsonPath
        : null,
    envelope,
    result,
    resultSource,
    resultIssues,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Find the last top-level JSON object in `text` and parse it. Returns null
 * if no balanced object is found. We can't just JSON.parse(text) because
 * openclaw prepends banner lines before its envelope.
 */
function extractTrailingJson(text: string): unknown | null {
  // Walk backward looking for the matching "{" that opens the trailing object.
  let depth = 0;
  let end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") {
      if (end < 0) end = i;
      depth++;
    } else if (ch === "{") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(i, end + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Fall through; reset and keep searching for a different match
          // (rare — would happen only with adversarial output).
          end = -1;
        }
      }
    }
  }
  return null;
}
