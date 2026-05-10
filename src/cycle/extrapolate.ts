import { v4 as uuid } from "uuid";
import type { Repo } from "../graph/repo.js";
import {
  NewEdge,
  NewNode,
  type EdgeType,
  type NodeStatus,
  type NodeType,
  type TaskKind,
} from "../graph/schema.js";
import { call as anthropicCall } from "../llm/anthropic.js";
import { openCallLogger } from "../llm/log.js";
import { MODELS } from "../llm/models.js";
import { recordUsage } from "../llm/usage.js";
import {
  EXTRAPOLATE_SYSTEM,
  SUBMIT_TOOL,
  SUBMIT_TOOL_NAME,
  buildUserMessage,
} from "../prompts/extrapolate.js";
import { assembleContext } from "./context.js";
import { ANTHROPIC_BETAS } from "../llm/models.js";
import { readAgentMemory, type AgentMemoryBundle } from "./memory.js";

interface ToolNode {
  local_id: string;
  type: NodeType;
  title: string;
  body: string;
  status?: NodeStatus;
  task_kind?: TaskKind;
  priority?: number;
  atomic?: boolean;
}

interface ToolEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight?: number;
  rationale?: string;
}

interface ToolInput {
  reasoning?: string;
  nodes: ToolNode[];
  edges: ToolEdge[];
}

export interface ExtrapolateOptions {
  /** Use a caller-supplied cycle id (so orchestrator can chain phases). */
  cycleId?: string;
  /** Override the default model. */
  model?: string;
  /** Token ceiling for the response. Push high — extrapolation should write a lot. */
  maxTokens?: number;
  /** Extended-thinking budget. 0 disables. Default 8192. */
  thinkingBudget?: number;
  /** Recency window for "recent related" nodes in context. */
  contextRecencyLimit?: number;
  /** Anthropic beta flags. Default empty; pass ["context-1m-2025-08-07"]
   *  for Opus 1M context when the source's neighborhood plus identity
   *  memory will exceed 200K tokens. */
  betas?: string[];
  /** Workspace dir to source the agent's identity memory from. When
   *  set, MEMORY.md / SOUL.md / IDENTITY.md / recent daily journal
   *  entries are concatenated into the user message above the graph
   *  context, so the extrapolator's voice is colored by the agent's
   *  accumulated perspective rather than just the prompt. */
  agentMemoryDir?: string;
}

export interface ExtrapolateResult {
  cycleId: string;
  sourceId: string;
  reasoning: string | null;
  newNodeIds: string[];
  newEdgeIds: string[];
  skippedEdges: { edge: ToolEdge; reason: string }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  durationMs: number;
  /** Path of the per-call log file. */
  logPath: string;
}

export async function extrapolate(
  repo: Repo,
  sourceId: string,
  opts: ExtrapolateOptions = {},
): Promise<ExtrapolateResult & { graphContextMarkdown: string }> {
  const cycleId = opts.cycleId ?? uuid();
  const startedAt = Date.now();

  const source = repo.getNode(sourceId);
  if (!source) throw new Error(`source node ${sourceId} not found`);

  const ctx = assembleContext(repo, sourceId, {
    recencyLimit: opts.contextRecencyLimit,
  });

  repo.recordEvent({
    type: "cycle_started",
    node_id: sourceId,
    payload: { cycle_id: cycleId, phase: "extrapolate" },
  });

  const model = opts.model ?? MODELS.extrapolation;
  // Opus supports up to ~32K standard output and even larger with thinking;
  // truncation is the real risk so we default near the ceiling.
  const maxTokens = opts.maxTokens ?? 32000;
  const thinkingBudget = opts.thinkingBudget ?? 32000;
  const betas = opts.betas ?? [ANTHROPIC_BETAS.context_1m];

  // Optional identity-memory injection. The bundle is appended to the
  // user message between the agent's identity preamble and the graph
  // context so the extrapolator inherits the agent's voice.
  let memBundle: AgentMemoryBundle | null = null;
  if (opts.agentMemoryDir) {
    memBundle = readAgentMemory(opts.agentMemoryDir);
  }

  const logger = openCallLogger({ cycleId, purpose: "extrapolate" });
  logger.event("cycle_started", {
    source_id: sourceId,
    source_type: source.type,
    source_title: source.title,
    model,
    max_tokens: maxTokens,
    thinking_budget: thinkingBudget,
    context_referenced_ids: ctx.referencedIds.length,
    context_chars: ctx.markdown.length,
    betas,
    memory_chars: memBundle?.text.length ?? 0,
    memory_files: memBundle?.files.length ?? 0,
  });
  logger.dump("graph_context", ctx.markdown);
  if (memBundle && memBundle.text.length > 0) {
    logger.dump("agent_memory", memBundle.text);
  }

  let result;
  try {
    // tool_choice cannot be forced when extended thinking is enabled, so we
    // rely on the system prompt's instruction to call the tool exactly once.
    result = await anthropicCall({
      model,
      system: EXTRAPOLATE_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildUserMessage(ctx.markdown, memBundle?.text ?? null),
        },
      ],
      tools: [SUBMIT_TOOL],
      max_tokens: maxTokens,
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

  const durationMs = Date.now() - startedAt;
  recordUsage(repo, {
    model,
    purpose: "extrapolate",
    cycle_id: cycleId,
    node_id: sourceId,
    usage: result.usage,
    durationMs,
  });

  if (!result.toolUse || result.toolUse.name !== SUBMIT_TOOL_NAME) {
    logger.event("tool_use_missing", {
      got: result.toolUse?.name ?? null,
      stop_reason: result.message.stop_reason,
    });
    logger.close();
    throw new Error(
      `expected ${SUBMIT_TOOL_NAME} tool use, got ${result.toolUse?.name ?? "no tool use"}. Stop reason: ${result.message.stop_reason}. Log: ${logger.path}`,
    );
  }

  // Truncation tolerance: when the model hits max_tokens mid-output, the
  // SDK still hands us whatever JSON it managed to parse. We accept partial
  // inputs as long as `nodes` is at least an array — even if edges is missing
  // or also truncated, we'd rather persist the partial taxonomy than throw.
  // The last node in the array may itself be partial; we filter those out
  // below at persist time (any node missing required fields is dropped).
  const rawInput = result.toolUse.input as Partial<ToolInput> | string | null;
  const input: ToolInput = {
    reasoning:
      rawInput && typeof rawInput === "object"
        ? (rawInput as ToolInput).reasoning
        : undefined,
    nodes:
      rawInput && typeof rawInput === "object" && Array.isArray((rawInput as ToolInput).nodes)
        ? (rawInput as ToolInput).nodes
        : [],
    edges:
      rawInput && typeof rawInput === "object" && Array.isArray((rawInput as ToolInput).edges)
        ? (rawInput as ToolInput).edges
        : [],
  };

  if (input.nodes.length === 0) {
    logger.event("tool_input_malformed", {
      stop_reason: result.message.stop_reason,
      input_keys:
        rawInput && typeof rawInput === "object"
          ? Object.keys(rawInput as Record<string, unknown>)
          : null,
      input_type: typeof rawInput,
    });
    logger.close();
    throw new Error(
      `tool input had no usable nodes. Stop reason: ${result.message.stop_reason}. Log: ${logger.path}`,
    );
  }

  const truncated = result.message.stop_reason === "max_tokens";
  if (truncated) {
    logger.event("truncation_recovery", {
      stop_reason: result.message.stop_reason,
      partial_nodes: input.nodes.length,
      partial_edges: input.edges.length,
      output_tokens: result.usage.output_tokens,
    });
  }

  const persisted = persistExtrapolation(repo, sourceId, ctx.referencedIds, input);

  // Mark source as in_progress (extrapolation has begun the work).
  if (source.status === "open") {
    repo.updateNode(sourceId, { status: "in_progress" });
  } else {
    repo.touchNode(sourceId);
  }

  repo.recordEvent({
    type: "cycle_phase_completed",
    node_id: sourceId,
    payload: {
      cycle_id: cycleId,
      phase: "extrapolate",
      new_nodes: persisted.newNodeIds.length,
      new_edges: persisted.newEdgeIds.length,
      skipped_edges: persisted.skippedEdges.length,
    },
  });
  repo.recordEvent({
    type: "cycle_completed",
    node_id: sourceId,
    payload: { cycle_id: cycleId, phase: "extrapolate" },
  });

  logger.event("persisted", {
    new_nodes: persisted.newNodeIds.length,
    new_edges: persisted.newEdgeIds.length,
    skipped_edges: persisted.skippedEdges.length,
  });
  if (persisted.skippedEdges.length) {
    logger.dump("skipped_edges", persisted.skippedEdges);
  }
  logger.close();

  return {
    cycleId,
    sourceId,
    reasoning: input.reasoning ?? null,
    newNodeIds: persisted.newNodeIds,
    newEdgeIds: persisted.newEdgeIds,
    skippedEdges: persisted.skippedEdges,
    usage: result.usage,
    durationMs,
    logPath: logger.path,
    graphContextMarkdown: ctx.markdown,
  };
}

export interface PersistResult {
  newNodeIds: string[];
  newEdgeIds: string[];
  skippedEdges: { edge: ToolEdge; reason: string }[];
}
export type { ToolInput, ToolNode, ToolEdge };

export function persistExtrapolation(
  repo: Repo,
  sourceId: string,
  contextIds: string[],
  input: ToolInput,
): PersistResult {
  const validContextIds = new Set(contextIds);
  // Always allow referencing the source itself.
  validContextIds.add(sourceId);

  const newNodeIds: string[] = [];
  const newEdgeIds: string[] = [];
  const skippedEdges: { edge: ToolEdge; reason: string }[] = [];

  repo.tx(() => {
    const localIdToUuid = new Map<string, string>();

    for (const n of input.nodes) {
      // Truncation can leave a final node with missing required fields; skip
      // those rather than crash. local_id duplication = model error, also drop.
      if (!n || typeof n !== "object") continue;
      if (!n.local_id || localIdToUuid.has(n.local_id)) continue;
      if (!n.type || typeof n.title !== "string" || n.title.length === 0) continue;
      if (typeof n.body !== "string") continue;
      const candidate: NewNode = {
        type: n.type,
        title: n.title,
        body: n.body,
        status: n.status ?? (isTaskLike(n.type) ? "open" : "n/a"),
        task_kind: n.task_kind ?? (isTaskLike(n.type) ? "oneoff" : null),
        priority:
          typeof n.priority === "number"
            ? clamp01(n.priority)
            : isTaskLike(n.type)
              ? 0.5
              : 0.5,
        schedule: null,
        due_at: null,
        metadata: { atomic: n.atomic ?? false },
      };
      const created = repo.createNode(candidate);
      localIdToUuid.set(n.local_id, created.id);
      newNodeIds.push(created.id);
    }

    for (const e of input.edges) {
      if (!e || typeof e !== "object") continue;
      if (!e.from || !e.to || !e.type) continue;
      const fromUuid = resolveRef(e.from, localIdToUuid, validContextIds);
      const toUuid = resolveRef(e.to, localIdToUuid, validContextIds);
      if (!fromUuid) {
        skippedEdges.push({ edge: e, reason: `unresolved 'from': ${e.from}` });
        continue;
      }
      if (!toUuid) {
        skippedEdges.push({ edge: e, reason: `unresolved 'to': ${e.to}` });
        continue;
      }
      if (fromUuid === toUuid) {
        skippedEdges.push({ edge: e, reason: "self-edge skipped" });
        continue;
      }
      const meta: Record<string, unknown> = {};
      if (e.rationale) meta.rationale = e.rationale;
      const candidate: NewEdge = {
        from_id: fromUuid,
        to_id: toUuid,
        type: e.type,
        weight: typeof e.weight === "number" ? clamp01(e.weight) : 1,
        metadata: meta,
      };
      const created = repo.addEdge(candidate);
      newEdgeIds.push(created.id);
    }
  });

  return { newNodeIds, newEdgeIds, skippedEdges };
}

function resolveRef(
  ref: string,
  localToUuid: Map<string, string>,
  validContextIds: Set<string>,
): string | null {
  if (localToUuid.has(ref)) return localToUuid.get(ref) ?? null;
  if (validContextIds.has(ref)) return ref;
  // Allow references to nodes that exist in the graph but weren't surfaced in
  // the context block (e.g. another root_purpose). Cheap existence check.
  // Caller validated source/context above; trust the rest.
  if (isUuid(ref)) return ref;
  return null;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

function isTaskLike(type: NodeType): boolean {
  return type === "task" || type === "root_purpose";
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
