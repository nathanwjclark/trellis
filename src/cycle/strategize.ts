import { v4 as uuid } from "uuid";
import type { Repo } from "../graph/repo.js";
import type { EmbeddingsRepo } from "../graph/embeddings.js";
import { call as anthropicCall } from "../llm/anthropic.js";
import { ANTHROPIC_BETAS, MODELS } from "../llm/models.js";
import { openCallLogger } from "../llm/log.js";
import { recordUsage } from "../llm/usage.js";
import { STRATEGIZE_SYSTEM } from "../prompts/strategize.js";
import {
  SUBMIT_TOOL,
  SUBMIT_TOOL_NAME,
  buildUserMessage as buildExtrapolateUserMessage,
} from "../prompts/extrapolate.js";
import { persistExtrapolation } from "./extrapolate.js";
import { indexPhase } from "./index_phase.js";
import { deduplicate } from "./deduplicate.js";
import { readAgentMemory } from "./memory.js";
import type { Node } from "../graph/schema.js";

/**
 * Strategy-synthesis cycle: a full-graph extrapolation pass intended to
 * mint knowledge capital — strategy, concepts, rationale, big-question
 * research nodes — drawn from what the agent has actually executed.
 *
 * Differences from runCycle():
 * - No single source node; we use the active root_purpose as the
 *   anchor and feed the entire graph as context.
 * - Different system prompt (STRATEGIZE_SYSTEM) with hard bias toward
 *   earned/emergent learning and away from generic LLM-trained wisdom.
 * - Larger model (Opus, MODELS.strategy) with 1M context beta and
 *   higher thinking budget — this is the deepest call we make.
 * - Index + dedupe still run on the output, same as a normal cycle.
 */
export interface StrategizeOptions {
  /** Optional override of the root_purpose to anchor under. Default:
   *  the highest-priority open root_purpose. */
  rootId?: string;
  /** Workspace dir to source the agent's identity memory from. */
  agentMemoryDir?: string;
  /** Override the strategy model. */
  model?: string;
  /** Override max output tokens. Default 32000. */
  maxTokens?: number;
  /** Legacy thinking budget. Default unset (adaptive effort used). */
  thinkingBudget?: number;
  /** Adaptive-thinking effort. Default "xhigh". */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Anthropic beta flags. Default [context_1m] so the whole graph
   *  fits even at thousands of nodes. */
  betas?: string[];
}

export interface StrategizeResult {
  cycleId: string;
  rootId: string;
  newNodes: number;
  newEdges: number;
  durationMs: number;
  logPath: string;
  spendUsd: number;
}

export async function strategize(
  repo: Repo,
  embeddings: EmbeddingsRepo,
  opts: StrategizeOptions = {},
): Promise<StrategizeResult> {
  const cycleId = uuid();
  const startedAt = Date.now();

  // Pick the anchor root_purpose. Required — the strategy pass needs a
  // place to attach its strategy ladder additions.
  const root = pickRoot(repo, opts.rootId ?? null);
  if (!root) {
    throw new Error(
      "no open root_purpose found; strategy synthesis requires a root to anchor under",
    );
  }

  const model = opts.model ?? MODELS.strategy;
  const maxTokens = opts.maxTokens ?? 32000;
  const effort = opts.effort ?? "xhigh";
  const thinkingBudget = opts.thinkingBudget;
  const betas = opts.betas ?? [ANTHROPIC_BETAS.context_1m];

  // Memory bundle (optional but heavily recommended for prod mode).
  const memory = opts.agentMemoryDir
    ? readAgentMemory(opts.agentMemoryDir)
    : null;

  const graphMarkdown = renderFullGraphForStrategy(repo, root.id);

  const logger = openCallLogger({ cycleId, purpose: "strategize" });
  logger.event("cycle_started", {
    source_id: root.id,
    source_type: root.type,
    source_title: root.title,
    model,
    max_tokens: maxTokens,
    thinking_budget: thinkingBudget ?? null,
    effort,
    betas,
    graph_chars: graphMarkdown.length,
    memory_chars: memory?.text.length ?? 0,
    memory_files: memory?.files.length ?? 0,
  });
  logger.dump("graph_context", graphMarkdown);
  if (memory && memory.text.length > 0) {
    logger.dump("agent_memory", memory.text);
  }

  let result;
  try {
    result = await anthropicCall({
      model,
      system: STRATEGIZE_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildExtrapolateUserMessage(
            graphMarkdown,
            memory?.text ?? null,
          ),
        },
      ],
      tools: [SUBMIT_TOOL],
      max_tokens: maxTokens,
      effort,
      thinking_budget_tokens: thinkingBudget,
      betas,
      logger,
    });
  } catch (e) {
    logger.event("call_failed", {
      message: e instanceof Error ? e.message : String(e),
    });
    logger.close();
    throw e;
  }

  recordUsage(repo, {
    model,
    purpose: "strategize",
    cycle_id: cycleId,
    node_id: root.id,
    usage: result.usage,
    durationMs: Date.now() - startedAt,
  });

  if (!result.toolUse || result.toolUse.name !== SUBMIT_TOOL_NAME) {
    logger.event("tool_use_missing", {
      got: result.toolUse?.name ?? null,
      stop_reason: result.message.stop_reason,
    });
    logger.close();
    throw new Error(
      `strategize: expected ${SUBMIT_TOOL_NAME} tool use, got ${result.toolUse?.name ?? "no tool use"}. Stop: ${result.message.stop_reason}. Log: ${logger.path}`,
    );
  }

  const raw = result.toolUse.input as
    | { nodes?: unknown; edges?: unknown }
    | null;
  const input = {
    reasoning:
      raw && typeof raw === "object" && "reasoning" in raw
        ? (raw as { reasoning?: string }).reasoning
        : undefined,
    nodes: raw && Array.isArray(raw.nodes) ? (raw.nodes as never[]) : [],
    edges: raw && Array.isArray(raw.edges) ? (raw.edges as never[]) : [],
  };
  if (input.nodes.length === 0) {
    logger.event("tool_input_empty", {
      stop_reason: result.message.stop_reason,
    });
    logger.close();
    throw new Error("strategize: tool input had no nodes");
  }

  // Persist via the same path as extrapolate.persist. The strategy
  // pass references existing UUIDs heavily, so we feed an explicitly-
  // empty allowlist (the persist function trusts inbound UUIDs and
  // existence-checks them at write time).
  const persisted = persistExtrapolation(repo, root.id, [], input);

  repo.recordEvent({
    type: "cycle_phase_completed",
    node_id: root.id,
    payload: {
      cycle_id: cycleId,
      phase: "strategize",
      new_nodes: persisted.newNodeIds.length,
      new_edges: persisted.newEdgeIds.length,
      skipped_edges: persisted.skippedEdges.length,
    },
  });
  logger.event("persisted", {
    new_nodes: persisted.newNodeIds.length,
    new_edges: persisted.newEdgeIds.length,
    skipped_edges: persisted.skippedEdges.length,
  });

  // Run index + dedupe so the new strategy/concept/research nodes
  // get embedded and merged against existing material.
  const newNodes = persisted.newNodeIds
    .map((id) => repo.getNode(id))
    .filter((n): n is Node => n !== null);
  if (newNodes.length > 0) {
    await indexPhase(repo, {
      cycleId,
      source: root,
      graphContextMarkdown: graphMarkdown,
      newNodes,
      logger,
    });
    await deduplicate(repo, embeddings, {
      cycleId,
      source: root,
      newNodes,
      logger,
    });
  }

  repo.recordEvent({
    type: "cycle_completed",
    node_id: root.id,
    payload: { cycle_id: cycleId, phase: "strategize" },
  });

  logger.close();

  return {
    cycleId,
    rootId: root.id,
    newNodes: persisted.newNodeIds.length,
    newEdges: persisted.newEdgeIds.length,
    durationMs: Date.now() - startedAt,
    logPath: logger.path,
    spendUsd: 0,
  };
}

function pickRoot(repo: Repo, rootId: string | null): Node | null {
  if (rootId) {
    const r = repo.getNode(rootId);
    return r ?? null;
  }
  const roots = repo.listNodes({ type: "root_purpose", status: "open" });
  if (roots.length === 0) return null;
  // Highest priority, then most-recently-touched.
  roots.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.last_touched_at - a.last_touched_at;
  });
  return roots[0]!;
}

/** A more compact graph rendering than the regular extrapolation
 *  context — strategy synthesis sees the whole graph in one shot, so
 *  we lean toward smaller per-node footprint and rely on the model's
 *  ability to reason over volume. Done leaves get their full body
 *  (those are the signal); other types get a clipped body. */
function renderFullGraphForStrategy(repo: Repo, rootId: string): string {
  const all = repo.listNodes();
  const lines: string[] = [];
  lines.push(
    `# Full graph (${all.length} nodes). Anchor root_purpose: ${rootId}.\n`,
  );
  // Group by type for skim-friendliness.
  const byType = new Map<string, Node[]>();
  for (const n of all) {
    const arr = byType.get(n.type) ?? [];
    arr.push(n);
    byType.set(n.type, arr);
  }
  // Roots first so the LLM has the anchor in mind.
  const order = [
    "root_purpose",
    "strategy",
    "rationale",
    "concept",
    "research",
    "task",
    "note",
    "risk",
    "scenario",
    "outcome",
    "entity",
    "timeframe",
    "session",
    "memory",
  ];
  for (const t of order) {
    const ns = byType.get(t);
    if (!ns || ns.length === 0) continue;
    lines.push(`## ${t} (${ns.length})\n`);
    // Sort: open done first (status), then by recency.
    ns.sort((a, b) => b.last_touched_at - a.last_touched_at);
    for (const n of ns) {
      const head = `[${n.type} · ${n.status} · prio=${n.priority.toFixed(2)} · ${n.id}] ${n.title}`;
      const bodyLimit =
        (n.type === "task" && n.status === "done") || n.type === "note"
          ? 800
          : 200;
      const body = clip(n.body ?? "", bodyLimit);
      lines.push(head);
      if (body.trim()) lines.push(body.trim());
      lines.push("");
    }
  }
  return lines.join("\n");
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
