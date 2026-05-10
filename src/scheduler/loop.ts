import { v4 as uuid } from "uuid";
import type { Repo } from "../graph/repo.js";
import type { EmbeddingsRepo } from "../graph/embeddings.js";
import type { Config } from "../cli/config.js";
import { runCycle } from "../cycle/orchestrate.js";
import { execute } from "../task/execute.js";
import { decideNextAction, type SchedulerDecision } from "./decide.js";
import { decideNextActionAgent } from "./decide_llm.js";
import { waitForChatQuiescence, chatSessionsDir } from "./quiescence.js";
import { spendInWindow } from "../llm/usage.js";
import { openCallLogger } from "../llm/log.js";

export type SchedulerKind = "agent" | "critical-path";

export interface LoopOptions {
  /** Restrict the loop to descendants of this root. */
  rootId?: string;
  /** Hard cap on iterations. */
  maxIterations?: number;
  /** Wall-clock budget in ms. */
  maxMs?: number;
  /** Estimated-USD budget for this loop run. */
  maxCostUsd?: number;
  /** Which scheduler to use to pick the next action. Default agent. */
  scheduler?: SchedulerKind;
  /** Print per-iteration progress. */
  onProgress?: (msg: string) => void;
}

export interface LoopIteration {
  iteration: number;
  decision: SchedulerDecision;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface LoopResult {
  loopId: string;
  iterations: LoopIteration[];
  stopReason: string;
  durationMs: number;
  spendUsd: number;
  logPath: string;
}

let signalCaught = false;

/**
 * Continuous daemon: picks the most-important open leaf, cycles it if
 * non-atomic, otherwise executes it, applies the result, and repeats.
 * Honors stop conditions (iteration cap, time cap, cost cap) and SIGINT/
 * SIGTERM for graceful shutdown.
 */
export async function runLoop(
  repo: Repo,
  embeddings: EmbeddingsRepo,
  cfg: Config,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const loopId = uuid();
  const startedAt = Date.now();
  const baselineSpend = spendInWindow(repo, 7 * 24 * 60 * 60 * 1000);
  const logger = openCallLogger({ cycleId: loopId, purpose: "loop" });
  const schedulerKind: SchedulerKind = opts.scheduler ?? "agent";

  // Install a one-shot signal handler. If the loop is invoked twice in the
  // same process (tests), only the latest set wins; the flag is module-level
  // so handlers from a prior call don't fire on a stale loop.
  signalCaught = false;
  const handler = () => {
    signalCaught = true;
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);

  logger.event("loop_started", {
    loop_id: loopId,
    root_id: opts.rootId ?? null,
    max_iterations: opts.maxIterations ?? null,
    max_ms: opts.maxMs ?? null,
    max_cost_usd: opts.maxCostUsd ?? null,
    scheduler: schedulerKind,
  });

  const iterations: LoopIteration[] = [];
  let stopReason = "iteration cap reached";

  try {
    while (true) {
      // ─── Stop conditions ─────────────────────────────────────────────
      if (signalCaught) {
        stopReason = "received SIGINT/SIGTERM";
        break;
      }
      if (
        opts.maxIterations !== undefined &&
        iterations.length >= opts.maxIterations
      ) {
        stopReason = `hit --iterations ${opts.maxIterations}`;
        break;
      }
      if (
        opts.maxMs !== undefined &&
        Date.now() - startedAt >= opts.maxMs
      ) {
        stopReason = `hit --max-time (${opts.maxMs}ms)`;
        break;
      }
      const currentSpend =
        spendInWindow(repo, 7 * 24 * 60 * 60 * 1000) - baselineSpend;
      if (
        opts.maxCostUsd !== undefined &&
        currentSpend >= opts.maxCostUsd
      ) {
        stopReason = `hit --max-cost ($${opts.maxCostUsd.toFixed(2)})`;
        break;
      }

      // ─── Chat precedence ─────────────────────────────────────────────
      // In prod mode with a chat agent watched, defer to active human
      // conversations: don't start a new leaf while a chat is in flight.
      if (chatSessionsDir(cfg)) {
        const q = await waitForChatQuiescence(cfg, {
          onWait: (waitedMs, lastActivityMs) => {
            const sec = Math.round((Date.now() - lastActivityMs) / 1000);
            opts.onProgress?.(
              `waiting for chat quiescence — last activity ${sec}s ago, waited ${Math.round(waitedMs / 1000)}s`,
            );
          },
        });
        if (q.waited) {
          logger.event("chat_quiescence_waited", {
            waited_ms: q.waitedMs,
            reason: q.reason,
          });
        }
      }
      if (signalCaught) {
        stopReason = "received SIGINT/SIGTERM";
        break;
      }

      // ─── Decide ──────────────────────────────────────────────────────
      const decision: SchedulerDecision =
        schedulerKind === "agent"
          ? await decideNextActionAgent(repo, {
              rootId: opts.rootId ?? null,
              cycleId: loopId,
              logger,
            })
          : decideNextAction(repo, { rootId: opts.rootId });
      if (decision.kind === "stop") {
        stopReason = decision.reason;
        logger.event("scheduler_stopped", { reason: decision.reason });
        break;
      }

      const iterIdx = iterations.length + 1;
      const iterStart = Date.now();
      const summary = `iter ${iterIdx}: ${decision.kind} → ${decision.node.id} "${decision.node.title}"`;
      opts.onProgress?.(summary);
      logger.event("iteration_started", {
        iteration: iterIdx,
        kind: decision.kind,
        node_id: decision.node.id,
        node_title: decision.node.title,
        reason: decision.reason,
      });

      // ─── Act ─────────────────────────────────────────────────────────
      const it: LoopIteration = {
        iteration: iterIdx,
        decision,
        durationMs: 0,
        ok: false,
      };
      try {
        if (decision.kind === "cycle") {
          await runCycle(repo, embeddings, decision.node.id);
        } else {
          await execute(repo, cfg, decision.node.id, {
            leafIdOverride: decision.node.id,
          });
        }
        it.ok = true;
      } catch (err) {
        it.ok = false;
        it.error = err instanceof Error ? err.message : String(err);
        logger.event("iteration_failed", {
          iteration: iterIdx,
          error: it.error,
        });
        // LLM calls are flaky. Don't block a node on the first failure —
        // record consecutive failure count in metadata; only block once
        // the same node has failed `MAX_CONSEC_FAILURES` times in a row.
        // Otherwise the next iteration is free to retry it.
        const MAX_CONSEC_FAILURES = 3;
        const meta = (decision.node.metadata ?? {}) as Record<string, unknown>;
        const prev = Number(meta.consec_failures ?? 0);
        const next = prev + 1;
        if (next >= MAX_CONSEC_FAILURES) {
          repo.updateNode(decision.node.id, {
            status: "blocked",
            metadata: {
              last_block_reason: it.error,
              consec_failures: next,
            },
          });
          logger.event("node_blocked", {
            node_id: decision.node.id,
            consec_failures: next,
            last_error: it.error,
          });
        } else {
          repo.updateNode(decision.node.id, {
            metadata: {
              consec_failures: next,
              last_error: it.error,
            },
          });
        }
      }
      // Reset failure counter on success so a node can recover from
      // intermittent flakes without permanent metadata cruft.
      if (it.ok) {
        const meta = (decision.node.metadata ?? {}) as Record<string, unknown>;
        if ("consec_failures" in meta) {
          repo.updateNode(decision.node.id, {
            metadata: { consec_failures: 0, last_error: null },
          });
        }
      }
      it.durationMs = Date.now() - iterStart;
      iterations.push(it);
      logger.event("iteration_completed", {
        iteration: iterIdx,
        ok: it.ok,
        duration_ms: it.durationMs,
        error: it.error,
      });
      const tail = it.ok
        ? `done in ${(it.durationMs / 1000).toFixed(1)}s`
        : `FAILED in ${(it.durationMs / 1000).toFixed(1)}s — ${it.error}`;
      opts.onProgress?.(`iter ${iterIdx} ${decision.kind} ${tail}`);
    }
  } finally {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
    logger.event("loop_completed", {
      iterations: iterations.length,
      stop_reason: stopReason,
      duration_ms: Date.now() - startedAt,
    });
    logger.close();
  }

  const finalSpend =
    spendInWindow(repo, 7 * 24 * 60 * 60 * 1000) - baselineSpend;

  return {
    loopId,
    iterations,
    stopReason,
    durationMs: Date.now() - startedAt,
    spendUsd: finalSpend,
    logPath: logger.path,
  };
}

