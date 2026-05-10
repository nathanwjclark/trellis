import type { Repo } from "../graph/repo.js";
import type {
  EdgeType,
  NewEdge,
  NewNode,
  Node,
  NodeType,
} from "../graph/schema.js";
import { call as anthropicCall } from "../llm/anthropic.js";
import type { CallLogger } from "../llm/log.js";
import { MODELS } from "../llm/models.js";
import { recordUsage } from "../llm/usage.js";
import {
  INDEX_SYSTEM,
  INDEX_TOOL,
  INDEX_TOOL_NAME,
  buildIndexUserMessage,
} from "../prompts/index_prompt.js";

interface ToolNode {
  local_id: string;
  type: "entity" | "concept" | "timeframe";
  title: string;
  body: string;
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

export interface IndexOptions {
  model?: string;
  maxTokens?: number;
}

export interface IndexResult {
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
}

export interface IndexInputs {
  cycleId: string;
  source: Node;
  graphContextMarkdown: string;
  /** Nodes created in the preceding extrapolation phase. */
  newNodes: Node[];
  logger?: CallLogger;
}

export async function indexPhase(
  repo: Repo,
  inputs: IndexInputs,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const startedAt = Date.now();
  const model = opts.model ?? MODELS.haiku;
  const maxTokens = opts.maxTokens ?? 8192;

  const newNodesMarkdown = renderNodesMarkdown(inputs.newNodes);

  inputs.logger?.event("phase_started", { phase: "index", model, max_tokens: maxTokens });

  const result = await anthropicCall({
    model,
    system: INDEX_SYSTEM,
    messages: [
      {
        role: "user",
        content: buildIndexUserMessage(
          inputs.graphContextMarkdown,
          newNodesMarkdown,
        ),
      },
    ],
    tools: [INDEX_TOOL],
    max_tokens: maxTokens,
    logger: inputs.logger,
  });

  const durationMs = Date.now() - startedAt;
  recordUsage(repo, {
    model,
    purpose: "index",
    cycle_id: inputs.cycleId,
    node_id: inputs.source.id,
    usage: result.usage,
    durationMs,
  });

  if (!result.toolUse || result.toolUse.name !== INDEX_TOOL_NAME) {
    inputs.logger?.event("tool_use_missing", {
      phase: "index",
      got: result.toolUse?.name ?? null,
      stop_reason: result.message.stop_reason,
    });
    throw new Error(
      `expected ${INDEX_TOOL_NAME} tool use, got ${result.toolUse?.name ?? "no tool use"}. Stop: ${result.message.stop_reason}`,
    );
  }

  const input = result.toolUse.input as ToolInput;
  // Tolerate the LLM omitting the (often-empty) edges array. nodes is the
  // required payload; edges add only mention links and frequently end up
  // as []. Treating a missing edges array as [] avoids killing the cycle
  // for an LLM lapse with no real information loss.
  if (!Array.isArray(input.nodes)) {
    inputs.logger?.event("tool_input_malformed", {
      phase: "index",
      input_keys:
        input && typeof input === "object" ? Object.keys(input) : null,
    });
    throw new Error("index tool input missing nodes array");
  }
  if (!Array.isArray(input.edges)) {
    inputs.logger?.event("tool_input_edges_defaulted", {
      phase: "index",
      input_keys: Object.keys(input),
    });
    input.edges = [];
  }

  // Build the set of node UUIDs the index phase is allowed to reference as
  // edge endpoints in the existing graph: the source plus its newly-
  // extrapolated descendants. We trust other UUIDs the model emits to a
  // lighter degree (existence-checked at write time below).
  const validExistingIds = new Set<string>([
    inputs.source.id,
    ...inputs.newNodes.map((n) => n.id),
  ]);

  const persisted = persistIndex(repo, validExistingIds, input);

  inputs.logger?.event("phase_persisted", {
    phase: "index",
    new_nodes: persisted.newNodeIds.length,
    new_edges: persisted.newEdgeIds.length,
    skipped_edges: persisted.skippedEdges.length,
  });

  repo.recordEvent({
    type: "cycle_phase_completed",
    node_id: inputs.source.id,
    payload: {
      cycle_id: inputs.cycleId,
      phase: "index",
      new_nodes: persisted.newNodeIds.length,
      new_edges: persisted.newEdgeIds.length,
      skipped_edges: persisted.skippedEdges.length,
    },
  });

  return {
    reasoning: input.reasoning ?? null,
    newNodeIds: persisted.newNodeIds,
    newEdgeIds: persisted.newEdgeIds,
    skippedEdges: persisted.skippedEdges,
    usage: result.usage,
    durationMs,
  };
}

interface PersistResult {
  newNodeIds: string[];
  newEdgeIds: string[];
  skippedEdges: { edge: ToolEdge; reason: string }[];
}

function persistIndex(
  repo: Repo,
  validContextIds: Set<string>,
  input: ToolInput,
): PersistResult {
  const newNodeIds: string[] = [];
  const newEdgeIds: string[] = [];
  const skippedEdges: { edge: ToolEdge; reason: string }[] = [];

  repo.tx(() => {
    const localIdToUuid = new Map<string, string>();

    for (const n of input.nodes) {
      if (!n.local_id || localIdToUuid.has(n.local_id)) continue;
      const allowed = (
        ["entity", "concept", "timeframe"] as NodeType[]
      ).includes(n.type as NodeType);
      if (!allowed) continue;
      const candidate: NewNode = {
        type: n.type,
        title: n.title,
        body: n.body,
        status: "n/a",
        task_kind: null,
        priority: 0.5,
        schedule: null,
        due_at: null,
        metadata: { from_phase: "index" },
      };
      const created = repo.createNode(candidate);
      localIdToUuid.set(n.local_id, created.id);
      newNodeIds.push(created.id);
    }

    for (const e of input.edges) {
      if (e.type !== "mentions" && e.type !== "relates_to") {
        skippedEdges.push({ edge: e, reason: `disallowed edge type: ${e.type}` });
        continue;
      }
      const fromUuid = resolveRef(e.from, localIdToUuid, validContextIds, repo);
      const toUuid = resolveRef(e.to, localIdToUuid, validContextIds, repo);
      if (!fromUuid) {
        skippedEdges.push({ edge: e, reason: `unresolved 'from': ${e.from}` });
        continue;
      }
      if (!toUuid) {
        skippedEdges.push({ edge: e, reason: `unresolved 'to': ${e.to}` });
        continue;
      }
      if (fromUuid === toUuid) {
        skippedEdges.push({ edge: e, reason: "self-edge" });
        continue;
      }
      const meta: Record<string, unknown> = { from_phase: "index" };
      if (e.rationale) meta.rationale = e.rationale;
      const candidate: NewEdge = {
        from_id: fromUuid,
        to_id: toUuid,
        type: e.type,
        weight: typeof e.weight === "number" ? Math.max(0, Math.min(1, e.weight)) : 1,
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
  repo: Repo,
): string | null {
  if (localToUuid.has(ref)) return localToUuid.get(ref) ?? null;
  if (validContextIds.has(ref)) return ref;
  // Allow other-UUID refs that actually exist in the graph (e.g., a strategy
  // node from extrapolation that we didn't surface in newNodesMarkdown).
  if (isUuid(ref) && repo.getNode(ref)) return ref;
  return null;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

function renderNodesMarkdown(nodes: Node[]): string {
  if (nodes.length === 0) return "_(no nodes)_";
  const lines: string[] = [];
  for (const n of nodes) {
    const head = `- **${n.type}** \`${n.id}\` — _${n.title}_`;
    const body = n.body.trim();
    const bodyLine = body
      ? `\n  ${body.slice(0, 320).replace(/\n+/g, " ")}${body.length > 320 ? "…" : ""}`
      : "";
    lines.push(`${head}${bodyLine}`);
  }
  return lines.join("\n");
}
