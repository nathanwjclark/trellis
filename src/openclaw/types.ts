import { z } from "zod";

/**
 * The structured result the agent writes to result.json at the end of its
 * working session. The agent is told the schema and the workspace path in
 * its bootstrap; we read the file when the openclaw subprocess exits.
 *
 * Loose by design — the agent might omit optional fields. We validate at
 * read time and fall back to safe defaults.
 */
export const ExecutionResult = z.object({
  /** The agent's verdict (or progress checkpoint) on the leaf task.
   *  "in_progress" is what progress.json checkpoints carry; result.json
   *  uses one of the terminal statuses. The adapter doesn't enforce
   *  which file gets which status — applyResult routes based on which
   *  file produced the value. */
  status: z.enum([
    "done",
    "blocked",
    // The agent has decided this leaf can't be completed without human
    // input or action — it goes onto a separate "human queue" surface
    // for the user to handle. Different from "blocked" (process error,
    // try again) and "cancelled" (kill the task).
    "human_blocked",
    "needs_decomposition",
    "cancelled",
    "in_progress",
  ]),
  /** One-paragraph summary of what was actually accomplished so far. */
  summary: z.string().min(1),
  /** Optional. Notes the agent wants to attach to the graph as note nodes. */
  notes: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .default([]),
  /** Optional. New tasks the agent surfaced during the work. */
  new_tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        priority: z.number().min(0).max(1).optional(),
        atomic: z.boolean().optional(),
      }),
    )
    .default([]),
  /** Optional. If the agent stopped early (blocked / needs_decomposition),
   *  this explains what's missing or how to decompose. */
  blocker: z.string().optional(),
  /** Optional. Files the agent wrote during work, relative to workspace. */
  artifacts: z.array(z.string()).default([]),
});
export type ExecutionResult = z.infer<typeof ExecutionResult>;

/**
 * The OpenClaw `agent --json` envelope shape we care about.
 * The full envelope is richer; we only validate fields we use.
 */
export const OpenclawEnvelope = z
  .object({
    payloads: z.array(z.unknown()).default([]),
    meta: z.record(z.unknown()).default({}),
    error: z.unknown().optional(),
  })
  .passthrough();
export type OpenclawEnvelope = z.infer<typeof OpenclawEnvelope>;
