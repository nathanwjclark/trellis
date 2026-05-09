import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";
import { call as anthropicCall } from "../llm/anthropic.js";
import type { CallLogger } from "../llm/log.js";
import { MODELS } from "../llm/models.js";
import { recordUsage } from "../llm/usage.js";
import { isOpen } from "../graph/traversal.js";
import type { SchedulerDecision } from "./decide.js";

const DECIDE_TOOL_NAME = "submit_decision";

const DECIDE_TOOL = {
  name: DECIDE_TOOL_NAME,
  description:
    "Submit your decision on what the agent should do next: execute an atomic open leaf, cycle (extrapolate) a non-atomic leaf, or stop.",
  input_schema: {
    type: "object" as const,
    properties: {
      reasoning: {
        type: "string",
        description:
          "One paragraph explaining how you considered the graph and arrived at this choice.",
      },
      action: { type: "string", enum: ["execute", "cycle", "stop"] },
      node_id: {
        type: "string",
        description:
          "UUID of the node to act on. Required for execute and cycle. Omit for stop.",
      },
      rationale: {
        type: "string",
        description:
          "One sentence summary suitable for a log line: why this node, why now.",
      },
    },
    required: ["reasoning", "action", "rationale"],
  },
};

const DECIDE_SYSTEM = `You are the scheduler for an autonomous agent's graph-native task substrate (Trellis). Each iteration, you look at the entire graph and decide what the agent should do next: **execute** an atomic open leaf (hand it to OpenClaw to do the work), **cycle** a non-atomic leaf to extrapolate it into subtasks, or **stop** if there's nothing useful left.

You are not the worker. Pick wisely, then return.

# How to read the graph

You'll get the full graph as a list, one node per line, with key fields:

\`\`\`
[type] status atomic? prio=N touched=Xm verified=Y <uuid> "<title>" parent=<uuid|root>
\`\`\`

- \`type\`: task, root_purpose, risk, scenario, outcome, rationale, strategy, concept, entity, timeframe, research, note, session, memory.
- \`status\`: open, in_progress, blocked, done, cancelled, n/a.
- \`atomic\`: \`atomic\` if the leaf is small enough to execute in one session (only set for tasks), \`compound\` otherwise.
- \`prio\`: 0–1 priority.
- \`touched\`: time since last_touched_at (e.g. "3m", "1h").
- \`verified\`: \`never\` if the executor has never investigated this node, otherwise time since the last successful agent verdict (e.g. "2d"). The scheduler should prefer \`never\` over recent verifications, and stale verifications over recent ones.
- \`parent\`: the most-relevant ancestor (subtask_of target), if any.

# How to choose

You can only pick **task** or **root_purpose** nodes. Other types are context, not work.

Prefer in this order:

1. **Atomic open tasks with \`verified=never\`.** Coverage matters: every leaf should be investigated at least once, so prefer untouched leaves first. They're the cheapest path to ground truth.
2. **Atomic open tasks with stale verifications (e.g. \`verified=7d\` or older).** Reality drifts; revisit periodically.
3. **Non-atomic open tasks that have no children yet.** Cycle them so the agent has more to do. Skip those that have already been cycled (they'll have many compound or atomic descendants).
4. **Atomic open tasks recently verified but with high priority.** Only when categories 1-3 are empty.
5. **Stop** if every open atomic task has \`verified\` within the last hour and there's no productive work to do — repeated re-verification of the same recently-checked leaves wastes budget.

Strong preferences:

- **Diversify across subtrees.** Don't keep picking from the same parent's children iteration after iteration. If a root has 5 immediate children, rotate between their subtrees so attention is balanced.
- **Avoid recently-touched same-node loops.** A leaf touched in the last 60 seconds is very likely the one we just did; do not pick it again unless you genuinely think a re-execute would help.
- **Don't pick blocked nodes.** They're set aside on purpose.
- **Don't cycle atomic tasks.** Their structure is already known; cycling produces noise.
- **Don't pick the same root_purpose's child twice in a row** unless that subtree has clearly more leverage than other subtrees. Rotation is healthy.

# Output

Call \`submit_decision\` exactly once per turn. \`action\` is one of \`execute\`, \`cycle\`, or \`stop\`. For execute/cycle, supply \`node_id\` (the full UUID from the graph listing).

If your previous pick was invalid (the user will tell you why), reconsider the graph and pick again. Don't blindly retry the same node; the validator's reason explains what's wrong.`;

export interface AgentDecideOptions {
  rootId?: string | null;
  maxRetries?: number;
  cycleId: string;
  logger?: CallLogger;
}

export async function decideNextActionAgent(
  repo: Repo,
  opts: AgentDecideOptions,
): Promise<SchedulerDecision> {
  const maxRetries = opts.maxRetries ?? 3;
  const graphText = renderGraphForDecision(repo, opts.rootId ?? null);

  const initialUserMessage = buildUserMessage(graphText, opts.rootId ?? null);
  const conversation: MessageParam[] = [
    { role: "user", content: initialUserMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    opts.logger?.event("scheduler_call", { attempt, retries_left: maxRetries - attempt });
    const result = await anthropicCall({
      model: MODELS.reasoning,
      system: DECIDE_SYSTEM,
      messages: conversation,
      tools: [DECIDE_TOOL],
      max_tokens: 4096,
      logger: opts.logger,
    });
    recordUsage(repo, {
      model: MODELS.reasoning,
      purpose: "scheduler_decide",
      cycle_id: opts.cycleId,
      usage: result.usage,
    });

    if (!result.toolUse || result.toolUse.name !== DECIDE_TOOL_NAME) {
      throw new Error(
        `scheduler expected ${DECIDE_TOOL_NAME} tool use; got ${result.toolUse?.name ?? "no tool use"}. Stop reason: ${result.message.stop_reason}`,
      );
    }

    const input = result.toolUse.input as DecisionInput;
    const validation = validateDecision(repo, input);

    if (validation.ok) {
      opts.logger?.event("scheduler_decided", {
        attempt,
        action: input.action,
        node_id: input.node_id,
        rationale: input.rationale,
      });
      if (input.action === "stop") {
        return {
          kind: "stop",
          reason: input.rationale ?? "agent chose to stop",
        };
      }
      const node = validation.node!;
      return {
        kind: input.action as "execute" | "cycle",
        node,
        reason: input.rationale ?? "agent pick",
      };
    }

    opts.logger?.event("scheduler_invalid_pick", {
      attempt,
      reason: validation.error,
      tried_action: input.action,
      tried_node_id: input.node_id,
    });

    // Push the assistant's message + a fresh user message explaining the
    // problem and asking for another attempt.
    conversation.push({
      role: "assistant",
      content: result.message.content,
    });
    conversation.push({
      role: "user",
      content: `Your previous pick was invalid: ${validation.error}\n\nReconsider the graph (it has not changed) and call submit_decision again with a valid choice.`,
    });
  }

  throw new Error(
    `scheduler LLM failed to pick a valid node after ${maxRetries + 1} attempts`,
  );
}

// ────────────────────────────────────────────────────────────────────────

interface DecisionInput {
  reasoning?: string;
  action?: string;
  node_id?: string;
  rationale?: string;
}

interface ValidationOk {
  ok: true;
  node?: Node;
}
interface ValidationFail {
  ok: false;
  error: string;
}

export function validateDecision(
  repo: Repo,
  input: DecisionInput,
): ValidationOk | ValidationFail {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "tool input was missing or malformed" };
  }
  if (!input.action) {
    return { ok: false, error: "missing required field 'action'" };
  }
  if (!["execute", "cycle", "stop"].includes(input.action)) {
    return {
      ok: false,
      error: `action must be 'execute', 'cycle', or 'stop'; got '${input.action}'`,
    };
  }

  if (input.action === "stop") {
    return { ok: true };
  }

  if (!input.node_id || typeof input.node_id !== "string") {
    return {
      ok: false,
      error: `action '${input.action}' requires a node_id (full UUID)`,
    };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.node_id)) {
    return {
      ok: false,
      error: `node_id '${input.node_id}' is not a valid UUID. Pick a full UUID from the graph listing.`,
    };
  }

  const node = repo.getNode(input.node_id);
  if (!node) {
    return {
      ok: false,
      error: `node '${input.node_id}' does not exist in the graph`,
    };
  }
  if (node.type !== "task" && node.type !== "root_purpose") {
    return {
      ok: false,
      error: `picked node is type '${node.type}'; only 'task' and 'root_purpose' nodes can be acted on`,
    };
  }
  if (!isOpen(node)) {
    return {
      ok: false,
      error: `picked node has status '${node.status}'; only open / in_progress / blocked nodes are eligible (and blocked is discouraged)`,
    };
  }

  // For execute, the node should be atomic (or at least an opinion that the
  // agent considered it). For cycle, it shouldn't already have many open
  // children (otherwise descend instead).
  const atomic = (node.metadata as Record<string, unknown>).atomic === true;
  if (input.action === "execute" && !atomic && node.type !== "root_purpose") {
    return {
      ok: false,
      error: `node '${node.id}' is not marked atomic; pick 'cycle' to extrapolate it first, or pick a different node that's atomic.`,
    };
  }
  if (input.action === "cycle" && atomic) {
    return {
      ok: false,
      error: `node '${node.id}' is already atomic; cycling it would produce noise. Pick 'execute' instead.`,
    };
  }

  return { ok: true, node };
}

// ────────────────────────────────────────────────────────────────────────

/**
 * Render the full graph (or root-restricted subgraph) as a compact
 * one-line-per-node text format the model can scan. Intentionally lossy:
 * full bodies are stripped to a 80-char title-summary; metadata is folded
 * into a single atomic? flag for tasks.
 */
export function renderGraphForDecision(
  repo: Repo,
  rootId: string | null,
): string {
  let nodes = repo.listNodes();
  if (rootId) {
    // Filter to the root_purpose plus its descendants via subtask_of (and
    // the immediate non-task children that explain context — strategies,
    // rationale, etc. — are kept too, so the model has full context).
    nodes = nodes.filter(
      (n) => n.id === rootId || nodeIsDescendantOf(repo, n.id, rootId),
    );
  }
  // Build parent_id map per node (most relevant subtask_of edge).
  const parentMap = new Map<string, string>();
  for (const n of nodes) {
    const parentEdges = repo.edgesFrom(n.id, "subtask_of");
    if (parentEdges.length > 0) parentMap.set(n.id, parentEdges[0]!.to_id);
  }
  const lines: string[] = [];
  for (const n of nodes) {
    const atomic =
      n.type === "task" && (n.metadata as Record<string, unknown>).atomic === true
        ? "atomic"
        : n.type === "task"
          ? "compound"
          : "-";
    const touched = formatRelative(n.last_touched_at);
    const verified = n.verified_at == null ? "never" : formatRelative(n.verified_at);
    const parent = parentMap.get(n.id) ?? "-";
    const titleClipped = clip(n.title, 80);
    lines.push(
      `[${n.type}] ${n.status} ${atomic} prio=${n.priority.toFixed(2)} touched=${touched} verified=${verified} ${n.id} "${titleClipped}" parent=${parent}`,
    );
  }
  // Sort: open atomic tasks first by priority desc, then by recency desc;
  // then everything else.
  lines.sort();
  return lines.join("\n");
}

function nodeIsDescendantOf(
  repo: Repo,
  nodeId: string,
  rootId: string,
): boolean {
  // Walk up subtask_of edges from nodeId; if we hit rootId, true.
  const seen = new Set<string>([nodeId]);
  let frontier = [nodeId];
  for (let depth = 0; depth < 50 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of repo.edgesFrom(id, "subtask_of")) {
        if (e.to_id === rootId) return true;
        if (seen.has(e.to_id)) continue;
        seen.add(e.to_id);
        next.push(e.to_id);
      }
    }
    frontier = next;
  }
  return false;
}

function buildUserMessage(graphText: string, rootId: string | null): string {
  const scope = rootId
    ? `Scope: descendants of root_purpose ${rootId} only.`
    : "Scope: every node in the graph.";
  return `${scope}\n\nThe full graph is below. Choose what to do next and call submit_decision exactly once.\n\n\`\`\`\n${graphText}\n\`\`\``;
}

function formatRelative(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 0) return "future?";
  if (dt < 60_000) return `${Math.max(1, Math.round(dt / 1000))}s`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h`;
  return `${Math.round(dt / 86_400_000)}d`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
