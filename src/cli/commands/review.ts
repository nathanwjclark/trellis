import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { call as anthropicCall } from "../../llm/anthropic.js";
import { MODELS } from "../../llm/models.js";
import { recordUsage } from "../../llm/usage.js";
import { TASK_STATUSES } from "../../graph/schema.js";
import { v4 as uuid } from "uuid";
import { openCallLogger } from "../../llm/log.js";
import { loadConfig } from "../config.js";

/**
 * `trellis review --human-blocked` — one-shot graph-wide pass to flag
 * tasks that require human action with status=human_blocked.
 *
 * Direct Anthropic call (Sonnet by default). The model receives the
 * full graph and outputs a list of (node_id, reason) decisions. We
 * apply them in a transaction. This is *not* a long-running session —
 * it's a structured pass for bulk re-statusing after a human
 * recognizes the agent has been generating tasks that secretly
 * require their input.
 *
 * Future kinds: `--cancel-stale`, `--re-prioritize`, etc. The CLI
 * shape lets us add more review modes without per-mode commands.
 */
export async function review(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  const kind =
    flags["human-blocked"] === true || flags.kind === "human-blocked"
      ? "human-blocked"
      : null;
  if (!kind) {
    db.close();
    throw new Error(
      "review requires --human-blocked (the only kind shipped so far)",
    );
  }

  const apply = flags.apply !== false; // default true, --no-apply to dry-run
  const cycleId = uuid();

  const tasks = repo
    .listNodes({ type: "task" })
    .filter(
      (n) => n.status === "open" || n.status === "in_progress",
    );
  if (tasks.length === 0) {
    process.stdout.write("no open/in_progress tasks to review.\n");
    db.close();
    return;
  }

  const graphMd = renderTasksForReview(tasks);
  const logger = openCallLogger({ cycleId, purpose: "review_human_blocked" });
  logger.event("review_started", { task_count: tasks.length, apply });
  logger.dump("graph_context", graphMd);

  const result = await anthropicCall({
    model: MODELS.reasoning,
    system: HUMAN_BLOCK_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Below is every open task in the graph. Identify which ones require Nathan's direct action / input / decision / credentials / real-world doing, and call \`flag_human_blocked\` once with the list.\n\n${graphMd}`,
      },
    ],
    tools: [FLAG_TOOL],
    max_tokens: 16000,
    thinking_budget_tokens: 4000,
    logger,
  });
  recordUsage(repo, {
    model: MODELS.reasoning,
    purpose: "review_human_blocked",
    cycle_id: cycleId,
    usage: result.usage,
  });

  if (!result.toolUse || result.toolUse.name !== "flag_human_blocked") {
    logger.event("tool_use_missing", {
      got: result.toolUse?.name ?? null,
      stop_reason: result.message.stop_reason,
    });
    logger.close();
    db.close();
    throw new Error(
      `review: expected flag_human_blocked tool use, got ${result.toolUse?.name ?? "no tool use"}`,
    );
  }
  const input = result.toolUse.input as {
    flagged?: { node_id: string; reason: string }[];
    reasoning?: string;
  };
  const flagged = Array.isArray(input.flagged) ? input.flagged : [];
  logger.event("review_decided", { flagged_count: flagged.length });

  const validIds = new Set(tasks.map((t) => t.id));
  let applied = 0;
  let skipped = 0;
  const log: { id: string; title: string; reason: string; applied: boolean }[] =
    [];

  for (const f of flagged) {
    if (!f || typeof f !== "object" || !f.node_id || !f.reason) {
      skipped++;
      continue;
    }
    if (!validIds.has(f.node_id)) {
      skipped++;
      continue;
    }
    const node = repo.getNode(f.node_id);
    if (!node) {
      skipped++;
      continue;
    }
    log.push({
      id: f.node_id,
      title: node.title,
      reason: f.reason,
      applied: apply,
    });
    if (apply) {
      repo.updateNode(f.node_id, {
        status: "human_blocked",
        metadata: {
          human_blocker: f.reason,
          flagged_at: Date.now(),
          flagged_by: "review_human_blocked",
        },
      });
      applied++;
    }
  }
  logger.event("review_applied", { applied, skipped, total: flagged.length });
  logger.close();

  process.stdout.write(
    `reviewed ${tasks.length} open tasks; flagged ${flagged.length} as human_blocked` +
      (apply ? `; applied ${applied}, skipped ${skipped}\n` : `; (--no-apply: dry run)\n`),
  );
  for (const e of log) {
    process.stdout.write(
      `  ${e.applied ? "✓" : "·"} ${e.id.slice(0, 8)}  ${e.title}\n      reason: ${e.reason}\n`,
    );
  }
  db.close();
}

const HUMAN_BLOCK_SYSTEM = `You are doing a one-time review of an autonomous agent's task graph. Your job is narrow and mechanical: identify which open tasks **cannot be completed without the human (Nathan) doing something or providing something**.

Use \`flag_human_blocked\` exactly once with an array of flagged tasks. For each, give the node_id (full UUID) and a one-sentence reason starting with what you need from Nathan.

# Flag a task as human_blocked when:

- It requires a credential, account, or API key Nathan controls
- It requires a real-world action (talking to a person, sending an email, running a payment, signing a doc)
- It requires Nathan's judgment on a strategic decision the agent shouldn't make alone (which two of three to commit to, whether to proceed past a gate)
- It depends on something Nathan would have to look up or remember (his calendar, who-he-knows-at-X, his preferred vendor)
- It involves talking to humans the agent doesn't have channels to reach (customer interviews, expert calls, user research)

# Do NOT flag when:

- The agent could plausibly do this with web research, code, or its existing tools
- It's a research/analysis task the agent can do on its own
- It's a planning/decomposition task
- The blocker would be the same for any agent (universal infra problems) — that's "blocked", not "human_blocked"

The reasons should be specific and actionable. "Needs Nathan's input" is too vague; "needs Nathan to confirm which carrier portal to prioritize first (Travelers vs Progressive) before the team can build" is good.

Be selective. Flagging too eagerly turns the human queue into noise; flagging too sparingly leaves the agent stuck. Aim for the tasks that *genuinely* need Nathan, not ones that are merely faster with him.`;

const FLAG_TOOL = {
  name: "flag_human_blocked",
  description: "Submit the list of tasks that require human action.",
  input_schema: {
    type: "object" as const,
    properties: {
      reasoning: {
        type: "string",
        description: "One paragraph explaining your filtering criteria.",
      },
      flagged: {
        type: "array",
        items: {
          type: "object",
          properties: {
            node_id: {
              type: "string",
              description: "Full UUID of the task to flag.",
            },
            reason: {
              type: "string",
              description:
                "One-sentence reason starting with what's needed from Nathan.",
            },
          },
          required: ["node_id", "reason"],
        },
      },
    },
    required: ["reasoning", "flagged"],
  },
};

function renderTasksForReview(
  tasks: { id: string; title: string; body: string; priority: number; status: string }[],
): string {
  const lines: string[] = [];
  for (const t of tasks) {
    const head = `[${t.id} · prio=${t.priority.toFixed(2)} · ${t.status}] ${t.title}`;
    const body = (t.body ?? "").trim().slice(0, 600);
    lines.push(head);
    if (body) lines.push(body);
    lines.push("");
  }
  return lines.join("\n");
}

// keep TASK_STATUSES referenced so any future addition here surfaces a build error
void TASK_STATUSES;
