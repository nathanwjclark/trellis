import type { Repo } from "../graph/repo.js";
import type { Node } from "../graph/schema.js";
import {
  EmbeddingsRepo,
  embedAndStore,
  nodeText,
} from "../graph/embeddings.js";
import { call as anthropicCall } from "../llm/anthropic.js";
import type { CallLogger } from "../llm/log.js";
import { MODELS } from "../llm/models.js";
import { recordUsage } from "../llm/usage.js";
import {
  DEDUPE_SYSTEM,
  DEDUPE_TOOL,
  DEDUPE_TOOL_NAME,
  type CandidateBlock,
  buildDedupeUserMessage,
} from "../prompts/dedupe_prompt.js";

export interface DedupeOptions {
  /** How many neighbors to consider per new node. */
  k?: number;
  /** Minimum cosine similarity for a candidate to be passed to the LLM. */
  minSimilarity?: number;
  /** Override Haiku model. */
  model?: string;
  /** Embedding model. Defaults to MODELS.embedding (Voyage). */
  embeddingModel?: string;
  /** When using a Voyage model and the key is missing, skip dedupe instead of
   *  failing. Default true. Local models don't need a key, so this only
   *  matters when the user explicitly opts into Voyage. */
  skipIfNoEmbeddingKey?: boolean;
}

export type Decision = "DUPLICATE_OF" | "VARIANT_OF" | "NOVEL";

export interface DedupeDecision {
  new_node_id: string;
  decision: Decision;
  target_id?: string;
  rationale?: string;
}

export interface DedupeResult {
  embeddedNodeIds: string[];
  decisions: DedupeDecision[];
  applied: {
    duplicates: number;
    variants: number;
    novel: number;
    selfLoopsRemoved: number;
    edgesRewritten: number;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  embeddingUsageTokens: number;
  durationMs: number;
  skipReason?: string;
}

export interface DedupeInputs {
  cycleId: string;
  source: Node;
  /** All nodes created in extrapolate + index this cycle. */
  newNodes: Node[];
  logger?: CallLogger;
}

export async function deduplicate(
  repo: Repo,
  embeddings: EmbeddingsRepo,
  inputs: DedupeInputs,
  opts: DedupeOptions = {},
): Promise<DedupeResult> {
  const startedAt = Date.now();
  const k = opts.k ?? 6;
  const minSimilarity = opts.minSimilarity ?? 0.65;
  const model = opts.model ?? MODELS.haiku;
  const embeddingModel = opts.embeddingModel ?? MODELS.embedding;
  const skipIfNoKey = opts.skipIfNoEmbeddingKey ?? true;

  inputs.logger?.event("phase_started", {
    phase: "dedupe",
    new_nodes: inputs.newNodes.length,
    k,
    minSimilarity,
    model,
    embedding_model: embeddingModel,
  });

  if (inputs.newNodes.length === 0) {
    inputs.logger?.event("phase_skipped", { phase: "dedupe", reason: "no new nodes" });
    return emptyResult(startedAt, 0, "no new nodes");
  }

  // Only skip-on-missing-key applies when the user opted into a Voyage model.
  // The local transformers.js path needs no key.
  const usesVoyage = embeddingModel.toLowerCase().startsWith("voyage-");
  if (skipIfNoKey && usesVoyage && !process.env.VOYAGE_API_KEY) {
    inputs.logger?.event("phase_skipped", {
      phase: "dedupe",
      reason: "VOYAGE_API_KEY not set",
    });
    repo.recordEvent({
      type: "cycle_phase_completed",
      node_id: inputs.source.id,
      payload: {
        cycle_id: inputs.cycleId,
        phase: "dedupe",
        skipped: true,
        reason: "VOYAGE_API_KEY not set",
      },
    });
    return emptyResult(startedAt, 0, "VOYAGE_API_KEY not set");
  }

  // Embed all new nodes (single batched API call).
  const embedResult = await embedAndStore(
    embeddings,
    repo,
    inputs.newNodes,
    embeddingModel,
  );
  const embeddingTokens = embedResult.usage.total_tokens;
  inputs.logger?.event("embedded_new_nodes", {
    count: inputs.newNodes.length,
    dim: embedResult.dim,
    tokens: embeddingTokens,
  });

  // For each new node, find top-K embedding-nearest existing nodes EXCLUDING
  // the set of new nodes we just embedded (we want to dedupe new-vs-existing,
  // not new-vs-self). For new-vs-new collisions detected within this cycle we
  // could relax this, but keeping it strict avoids weird mutual-merge cases
  // for v0.1.
  const newNodeIdSet = new Set(inputs.newNodes.map((n) => n.id));
  const candidatesByNew: CandidateBlock[] = [];
  for (const n of inputs.newNodes) {
    const vec = embedResult.vectors.get(n.id);
    if (!vec) continue;
    const neighbors = embeddings.nearestNeighbors(vec, {
      model: embeddingModel,
      k,
      excludeNodeIds: newNodeIdSet,
      minSimilarity,
    });
    if (neighbors.length === 0) continue;
    const candidates: CandidateBlock["candidates"] = [];
    for (const nb of neighbors) {
      const cand = repo.getNode(nb.node_id);
      if (!cand) continue;
      candidates.push({
        id: cand.id,
        type: cand.type,
        title: cand.title,
        body: cand.body,
        similarity: nb.similarity,
      });
    }
    if (candidates.length === 0) continue;
    candidatesByNew.push({
      newNodeId: n.id,
      newType: n.type,
      newTitle: n.title,
      newBody: n.body,
      candidates,
    });
  }

  inputs.logger?.event("candidates_assembled", {
    blocks: candidatesByNew.length,
    total_candidates: candidatesByNew.reduce(
      (s, b) => s + b.candidates.length,
      0,
    ),
  });

  if (candidatesByNew.length === 0) {
    // Nothing to ask the LLM about; everything is implicitly NOVEL.
    repo.recordEvent({
      type: "cycle_phase_completed",
      node_id: inputs.source.id,
      payload: {
        cycle_id: inputs.cycleId,
        phase: "dedupe",
        novel: inputs.newNodes.length,
        duplicates: 0,
        variants: 0,
        skipped: false,
      },
    });
    return {
      embeddedNodeIds: [...newNodeIdSet],
      decisions: inputs.newNodes.map((n) => ({
        new_node_id: n.id,
        decision: "NOVEL" as const,
        rationale: "no embedding-nearest candidates above threshold",
      })),
      applied: {
        duplicates: 0,
        variants: 0,
        novel: inputs.newNodes.length,
        selfLoopsRemoved: 0,
        edgesRewritten: 0,
      },
      usage: zeroUsage(),
      embeddingUsageTokens: embeddingTokens,
      durationMs: Date.now() - startedAt,
    };
  }

  // Single Haiku call for all decisions.
  const result = await anthropicCall({
    model,
    system: DEDUPE_SYSTEM,
    messages: [{ role: "user", content: buildDedupeUserMessage(candidatesByNew) }],
    tools: [DEDUPE_TOOL],
    max_tokens: 8192,
    logger: inputs.logger,
  });

  const phaseDurationMs = Date.now() - startedAt;
  recordUsage(repo, {
    model,
    purpose: "dedupe",
    cycle_id: inputs.cycleId,
    node_id: inputs.source.id,
    usage: result.usage,
    durationMs: phaseDurationMs,
  });

  if (!result.toolUse || result.toolUse.name !== DEDUPE_TOOL_NAME) {
    inputs.logger?.event("tool_use_missing", {
      phase: "dedupe",
      got: result.toolUse?.name ?? null,
    });
    throw new Error(
      `expected ${DEDUPE_TOOL_NAME} tool use, got ${result.toolUse?.name ?? "no tool use"}`,
    );
  }
  const input = result.toolUse.input as { decisions?: DedupeDecision[] };
  if (!Array.isArray(input.decisions)) {
    throw new Error("dedupe tool input missing decisions array");
  }

  // Apply decisions.
  const applied = applyDecisions(repo, embeddings, inputs, input.decisions);

  inputs.logger?.event("phase_persisted", {
    phase: "dedupe",
    duplicates: applied.duplicates,
    variants: applied.variants,
    novel: applied.novel,
    edges_rewritten: applied.edgesRewritten,
    self_loops_removed: applied.selfLoopsRemoved,
  });

  repo.recordEvent({
    type: "cycle_phase_completed",
    node_id: inputs.source.id,
    payload: {
      cycle_id: inputs.cycleId,
      phase: "dedupe",
      ...applied,
    },
  });

  return {
    embeddedNodeIds: [...newNodeIdSet],
    decisions: input.decisions,
    applied,
    usage: result.usage,
    embeddingUsageTokens: embeddingTokens,
    durationMs: phaseDurationMs,
  };
}

function applyDecisions(
  repo: Repo,
  embeddings: EmbeddingsRepo,
  inputs: DedupeInputs,
  decisions: DedupeDecision[],
): {
  duplicates: number;
  variants: number;
  novel: number;
  edgesRewritten: number;
  selfLoopsRemoved: number;
} {
  let duplicates = 0;
  let variants = 0;
  let novel = 0;
  let edgesRewritten = 0;
  let selfLoopsRemoved = 0;

  // Build a quick lookup of new-node ids so we don't accidentally redirect
  // edges of nodes that aren't ours to touch.
  const newNodeIds = new Set(inputs.newNodes.map((n) => n.id));

  for (const d of decisions) {
    if (!newNodeIds.has(d.new_node_id)) continue;
    const newNode = repo.getNode(d.new_node_id);
    if (!newNode) continue;

    if (d.decision === "DUPLICATE_OF" && d.target_id) {
      const existing = repo.getNode(d.target_id);
      if (!existing || existing.id === newNode.id) {
        novel++;
        repo.recordEvent({
          type: "dedupe_decision",
          node_id: newNode.id,
          payload: {
            cycle_id: inputs.cycleId,
            decision: "NOVEL",
            note: "duplicate target invalid; kept as novel",
            attempted_target: d.target_id,
            rationale: d.rationale,
          },
        });
        continue;
      }
      const stats = repo.redirectEdgeRefs(newNode.id, existing.id);
      edgesRewritten += stats.rewrittenFrom + stats.rewrittenTo;
      selfLoopsRemoved += stats.selfLoopsRemoved;
      // Drop the embedding for the merged-away node before deleting.
      embeddings.delete(newNode.id);
      repo.deleteNode(newNode.id);
      duplicates++;
      repo.recordEvent({
        type: "dedupe_decision",
        node_id: existing.id,
        payload: {
          cycle_id: inputs.cycleId,
          decision: "DUPLICATE_OF",
          merged_node: newNode.id,
          target_id: existing.id,
          edges_rewritten: stats.rewrittenFrom + stats.rewrittenTo,
          rationale: d.rationale,
        },
      });
    } else if (d.decision === "VARIANT_OF" && d.target_id) {
      const existing = repo.getNode(d.target_id);
      if (!existing || existing.id === newNode.id) {
        novel++;
        continue;
      }
      repo.addEdge({
        from_id: newNode.id,
        to_id: existing.id,
        type: "relates_to",
        weight: 0.7,
        metadata: {
          from_phase: "dedupe",
          relation: "VARIANT_OF",
          rationale: d.rationale ?? null,
        },
      });
      variants++;
      repo.recordEvent({
        type: "dedupe_decision",
        node_id: newNode.id,
        payload: {
          cycle_id: inputs.cycleId,
          decision: "VARIANT_OF",
          target_id: existing.id,
          rationale: d.rationale,
        },
      });
    } else {
      novel++;
      repo.recordEvent({
        type: "dedupe_decision",
        node_id: newNode.id,
        payload: {
          cycle_id: inputs.cycleId,
          decision: "NOVEL",
          rationale: d.rationale,
        },
      });
    }
  }

  return { duplicates, variants, novel, edgesRewritten, selfLoopsRemoved };
}

function emptyResult(startedAt: number, embeddingTokens: number, reason: string): DedupeResult {
  return {
    embeddedNodeIds: [],
    decisions: [],
    applied: {
      duplicates: 0,
      variants: 0,
      novel: 0,
      selfLoopsRemoved: 0,
      edgesRewritten: 0,
    },
    usage: zeroUsage(),
    embeddingUsageTokens: embeddingTokens,
    durationMs: Date.now() - startedAt,
    skipReason: reason,
  };
}

function zeroUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

// Keep nodeText referenced so the import isn't trimmed; used implicitly via
// embedAndStore but explicit here makes future changes easier.
void nodeText;
