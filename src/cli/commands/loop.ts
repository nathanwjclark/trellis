import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { EmbeddingsRepo } from "../../graph/embeddings.js";
import { runLoop, type SchedulerKind } from "../../scheduler/loop.js";
import { loadConfig } from "../config.js";

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;

function parseDurationMs(input: string): number {
  const m = DURATION_RE.exec(input.trim());
  if (!m) throw new Error(`invalid duration: ${input} (use e.g. 90s, 5m, 1h)`);
  const value = Number.parseFloat(m[1]!);
  switch (m[2]) {
    case "ms":
      return Math.round(value);
    case "s":
    case undefined:
      return Math.round(value * 1000);
    case "m":
      return Math.round(value * 60_000);
    case "h":
      return Math.round(value * 3_600_000);
    default:
      throw new Error(`invalid duration unit: ${m[2]}`);
  }
}

export async function loopCmd(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);
  const embeddings = new EmbeddingsRepo(db, repo);

  const rootId = typeof flags["root"] === "string" ? flags["root"] : undefined;
  const maxIterations =
    typeof flags["iterations"] === "string"
      ? Number.parseInt(flags["iterations"], 10)
      : undefined;
  const maxMs =
    typeof flags["max-time"] === "string"
      ? parseDurationMs(flags["max-time"])
      : undefined;
  const maxCostUsd =
    typeof flags["max-cost"] === "string"
      ? Number.parseFloat(flags["max-cost"])
      : undefined;
  const schedulerFlag =
    typeof flags["scheduler"] === "string" ? flags["scheduler"] : "agent";
  if (schedulerFlag !== "agent" && schedulerFlag !== "critical-path") {
    throw new Error(
      `--scheduler must be 'agent' or 'critical-path', got '${schedulerFlag}'`,
    );
  }
  const scheduler: SchedulerKind = schedulerFlag;

  process.stdout.write(`starting daemon loop\n`);
  process.stdout.write(`  scheduler:      ${scheduler}\n`);
  if (rootId) process.stdout.write(`  root:           ${rootId}\n`);
  if (maxIterations !== undefined)
    process.stdout.write(`  max iterations: ${maxIterations}\n`);
  if (maxMs !== undefined)
    process.stdout.write(`  max time:       ${(maxMs / 1000).toFixed(0)}s\n`);
  if (maxCostUsd !== undefined)
    process.stdout.write(`  max cost:       $${maxCostUsd.toFixed(2)}\n`);
  process.stdout.write(`  ctrl+c to stop\n\n`);

  // In prod mode, the agent workspace doubles as identity-memory
  // source for the deeper extrapolation calls (cycle + strategize).
  // In test mode we leave it null so the prompt doesn't get a
  // synthetic-identity bundle that doesn't reflect anything real.
  const agentMemoryDir =
    cfg.openclawMode === "prod" ? cfg.agentWorkspaceDir : undefined;

  const result = await runLoop(repo, embeddings, cfg, {
    rootId,
    maxIterations,
    maxMs,
    maxCostUsd,
    scheduler,
    agentMemoryDir,
    onProgress: (msg) => {
      const ts = new Date().toISOString().slice(11, 19);
      process.stdout.write(`[${ts}] ${msg}\n`);
    },
  });

  process.stdout.write(`\n✓ loop ended\n`);
  process.stdout.write(`  loop id:        ${result.loopId}\n`);
  process.stdout.write(`  iterations:     ${result.iterations.length}\n`);
  process.stdout.write(`  duration:       ${(result.durationMs / 1000).toFixed(1)}s\n`);
  process.stdout.write(`  est. spend:     $${result.spendUsd.toFixed(4)}  (trellis-side only; excludes openclaw subprocess token cost)\n`);
  process.stdout.write(`  stop reason:    ${result.stopReason}\n`);
  process.stdout.write(`  log:            ${result.logPath}\n\n`);

  const ok = result.iterations.filter((i) => i.ok).length;
  const fail = result.iterations.length - ok;
  if (result.iterations.length > 0) {
    process.stdout.write(`per-iteration breakdown:\n`);
    process.stdout.write(`  succeeded:      ${ok}\n`);
    process.stdout.write(`  failed:         ${fail}\n\n`);
    if (fail > 0) {
      process.stdout.write(`failures:\n`);
      for (const i of result.iterations) {
        if (!i.ok) {
          process.stdout.write(
            `  iter ${i.iteration} (${i.decision.kind === "stop" ? "stop" : i.decision.node.id}): ${i.error}\n`,
          );
        }
      }
    }
  }

  db.close();
}
