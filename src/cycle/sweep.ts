import { v4 as uuid } from "uuid";
import type { Repo } from "../graph/repo.js";
import {
  EmbeddingsRepo,
  backfillEmbeddings,
} from "../graph/embeddings.js";
import { call as anthropicCall } from "../llm/anthropic.js";
import { openCallLogger } from "../llm/log.js";
import { MODELS } from "../llm/models.js";
import { recordUsage } from "../llm/usage.js";
import {
  DEDUPE_SYSTEM,
  DEDUPE_TOOL,
  DEDUPE_TOOL_NAME,
  type CandidateBlock,
  buildDedupeUserMessage,
} from "../prompts/dedupe_prompt.js";

export interface SweepOptions {
  model?: string;
  embeddingModel?: string;
  /** Top-K neighbors to consider per node. Default 4. */
  k?: number;
  /** Minimum cosine similarity for a candidate to be considered. Default 0.78. */
  minSimilarity?: number;
  /** Number of candidate blocks per Haiku call. Default 25. */
  chunkSize?: number;
  /** Skip the embedding backfill step (fail if any node lacks an embedding). */
  skipBackfill?: boolean;
  /** Restrict the sweep to nodes of these types. Default: all types. */
  nodeTypes?: string[];
}

export type SweepDecision =
  | { new_node_id: string; decision: "DUPLICATE_OF"; target_id: string; rationale?: string }
  | { new_node_id: string; decision: "VARIANT_OF"; target_id: string; rationale?: string }
  | { new_node_id: string; decision: "NOVEL"; rationale?: string };

export interface SweepResult {
  sweepId: string;
  durationMs: number;
  backfill: {
    embedded: number;
    alreadyHad: number;
    usageTokens: number;
  };
  blocksConsidered: number;
  haikuChunks: number;
  decisions: SweepDecision[];
  applied: {
    duplicates: number;
    variants: number;
    novel: number;
    edgesRewritten: number;
    selfLoopsRemoved: number;
    chainCollapses: number;
  };
  haikuUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  logPath: string;
}

export async function dedupeSweep(
  repo: Repo,
  embeddings: EmbeddingsRepo,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const sweepId = uuid();
  const startedAt = Date.now();
  const model = opts.model ?? MODELS.haiku;
  const embeddingModel = opts.embeddingModel ?? MODELS.embedding;
  const k = opts.k ?? 4;
  const minSimilarity = opts.minSimilarity ?? 0.78;
  const chunkSize = opts.chunkSize ?? 25;

  const logger = openCallLogger({ cycleId: sweepId, purpose: "dedupe_sweep" });
  logger.event("sweep_started", {
    model,
    embedding_model: embeddingModel,
    k,
    min_similarity: minSimilarity,
    chunk_size: chunkSize,
  });

  try {
    // ─── 1. Backfill ──────────────────────────────────────────────────────
    let backfillStats = { embedded: 0, alreadyHad: 0, usageTokens: 0 };
    if (!opts.skipBackfill) {
      const r = await backfillEmbeddings(embeddings, repo, {
        model: embeddingModel,
        onProgress: (done, total) =>
          logger.event("backfill_progress", { done, total }),
      });
      backfillStats = {
        embedded: r.embedded,
        alreadyHad: r.alreadyHad,
        usageTokens: r.usageTokens,
      };
      logger.event("backfill_done", backfillStats);
    }

    // ─── 2. Build candidate blocks ────────────────────────────────────────
    const allNodes = repo.listNodes();
    const filteredNodes = opts.nodeTypes
      ? allNodes.filter((n) => opts.nodeTypes!.includes(n.type))
      : allNodes;

    const blocks: CandidateBlock[] = [];
    let pairsConsidered = 0;
    for (const n of filteredNodes) {
      const e = embeddings.get(n.id);
      if (!e || e.model !== embeddingModel) continue;
      const neighbors = embeddings.nearestNeighbors(e.vector, {
        model: embeddingModel,
        k,
        excludeNodeIds: new Set([n.id]),
        minSimilarity,
      });
      if (neighbors.length === 0) continue;
      // Half the work: only consider this pair if our id sorts before the
      // candidate's id. The reverse direction would emit the same pair.
      const filtered = neighbors.filter((nb) => n.id < nb.node_id);
      if (filtered.length === 0) continue;
      pairsConsidered += filtered.length;
      const candidates: CandidateBlock["candidates"] = [];
      for (const nb of filtered) {
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
      blocks.push({
        newNodeId: n.id,
        newType: n.type,
        newTitle: n.title,
        newBody: n.body,
        candidates,
      });
    }
    logger.event("blocks_built", {
      blocks: blocks.length,
      pairs_considered: pairsConsidered,
      total_nodes_scanned: filteredNodes.length,
    });

    if (blocks.length === 0) {
      logger.event("sweep_complete_no_pairs");
      return {
        sweepId,
        durationMs: Date.now() - startedAt,
        backfill: backfillStats,
        blocksConsidered: 0,
        haikuChunks: 0,
        decisions: [],
        applied: {
          duplicates: 0,
          variants: 0,
          novel: 0,
          edgesRewritten: 0,
          selfLoopsRemoved: 0,
          chainCollapses: 0,
        },
        haikuUsage: zeroUsage(),
        logPath: logger.path,
      };
    }

    // ─── 3. Chunked Haiku decisions ──────────────────────────────────────
    const allDecisions: SweepDecision[] = [];
    const totalUsage = zeroUsage();
    const chunkCount = Math.ceil(blocks.length / chunkSize);
    for (let ci = 0; ci < chunkCount; ci++) {
      const chunk = blocks.slice(ci * chunkSize, (ci + 1) * chunkSize);
      logger.event("haiku_chunk_start", {
        chunk: ci + 1,
        of: chunkCount,
        blocks: chunk.length,
      });
      const result = await anthropicCall({
        model,
        system: DEDUPE_SYSTEM,
        messages: [
          { role: "user", content: buildDedupeUserMessage(chunk) },
        ],
        tools: [DEDUPE_TOOL],
        max_tokens: 8192,
        logger,
      });
      recordUsage(repo, {
        model,
        purpose: "dedupe_sweep",
        cycle_id: sweepId,
        usage: result.usage,
      });
      totalUsage.input_tokens += result.usage.input_tokens;
      totalUsage.output_tokens += result.usage.output_tokens;
      totalUsage.cache_creation_input_tokens += result.usage.cache_creation_input_tokens;
      totalUsage.cache_read_input_tokens += result.usage.cache_read_input_tokens;
      if (!result.toolUse || result.toolUse.name !== DEDUPE_TOOL_NAME) {
        logger.event("tool_use_missing", {
          chunk: ci + 1,
          got: result.toolUse?.name ?? null,
        });
        continue;
      }
      const input = result.toolUse.input as { decisions?: SweepDecision[] };
      if (!Array.isArray(input.decisions)) continue;
      for (const d of input.decisions) {
        allDecisions.push(d);
      }
    }

    logger.event("decisions_collected", { total: allDecisions.length });

    // ─── 4. Apply with transitive merge resolution ───────────────────────
    const applied = applyTransitive(repo, embeddings, allDecisions, sweepId, logger);

    repo.recordEvent({
      type: "dream_applied",
      payload: {
        sweep_id: sweepId,
        ...applied,
        blocks_considered: blocks.length,
      },
    });

    logger.event("sweep_complete", {
      ...applied,
      haiku_input_tokens: totalUsage.input_tokens,
      haiku_output_tokens: totalUsage.output_tokens,
    });

    return {
      sweepId,
      durationMs: Date.now() - startedAt,
      backfill: backfillStats,
      blocksConsidered: blocks.length,
      haikuChunks: chunkCount,
      decisions: allDecisions,
      applied,
      haikuUsage: totalUsage,
      logPath: logger.path,
    };
  } finally {
    logger.close();
  }
}

/**
 * Apply DUPLICATE_OF decisions transitively. If A → B and B → C, then A → C.
 * Variants are added after duplicates so they can't reference merged-away
 * nodes. NOVEL decisions are no-ops.
 */
function applyTransitive(
  repo: Repo,
  embeddings: EmbeddingsRepo,
  decisions: SweepDecision[],
  sweepId: string,
  logger: { event: (k: string, d?: Record<string, unknown>) => void },
): {
  duplicates: number;
  variants: number;
  novel: number;
  edgesRewritten: number;
  selfLoopsRemoved: number;
  chainCollapses: number;
} {
  // ── First pass: build the duplicate chain map.
  const mergedTo = new Map<string, string>();
  let chainCollapses = 0;

  // resolve(id): walk the merged chain to its terminal canonical id.
  const resolve = (id: string): string => {
    let cur = id;
    let hops = 0;
    while (mergedTo.has(cur)) {
      const nxt = mergedTo.get(cur)!;
      if (nxt === cur) break;
      cur = nxt;
      hops++;
      if (hops > 100) break; // pathological cycle guard
    }
    if (hops > 1) chainCollapses++;
    return cur;
  };

  const dupes = decisions.filter(
    (d): d is Extract<SweepDecision, { decision: "DUPLICATE_OF" }> =>
      d.decision === "DUPLICATE_OF" && typeof d.target_id === "string",
  );
  const variants = decisions.filter(
    (d): d is Extract<SweepDecision, { decision: "VARIANT_OF" }> =>
      d.decision === "VARIANT_OF" && typeof d.target_id === "string",
  );
  const novel = decisions.filter((d) => d.decision === "NOVEL");

  // Plan duplicate merges, accounting for transitivity.
  for (const d of dupes) {
    const src = d.new_node_id;
    const tgt = resolve(d.target_id);
    if (src === tgt) continue; // already same canonical
    // If src was already targeted by something else, skip (can't double-merge).
    if (mergedTo.has(src)) continue;
    // Don't merge if src is the canonical of an existing chain (would orphan).
    // A simple guard: don't merge a node that other nodes have been merged INTO.
    let isCanonical = false;
    for (const v of mergedTo.values()) {
      if (v === src) {
        isCanonical = true;
        break;
      }
    }
    if (isCanonical) continue;
    mergedTo.set(src, tgt);
  }

  // ── Second pass: apply duplicate merges.
  let duplicateCount = 0;
  let edgesRewritten = 0;
  let selfLoopsRemoved = 0;
  for (const [src, tgt] of mergedTo) {
    const srcNode = repo.getNode(src);
    const tgtNode = repo.getNode(tgt);
    if (!srcNode || !tgtNode) continue;
    const stats = repo.redirectEdgeRefs(src, tgt);
    edgesRewritten += stats.rewrittenFrom + stats.rewrittenTo;
    selfLoopsRemoved += stats.selfLoopsRemoved;
    embeddings.delete(src);
    repo.deleteNode(src);
    duplicateCount++;
    repo.recordEvent({
      type: "dedupe_decision",
      node_id: tgt,
      payload: {
        sweep_id: sweepId,
        decision: "DUPLICATE_OF",
        merged_node: src,
        target_id: tgt,
        edges_rewritten: stats.rewrittenFrom + stats.rewrittenTo,
        from: "sweep",
      },
    });
  }
  logger.event("duplicates_applied", {
    count: duplicateCount,
    edges_rewritten: edgesRewritten,
    self_loops: selfLoopsRemoved,
    chain_collapses: chainCollapses,
  });

  // ── Third pass: apply variants (skip if either side merged away).
  let variantCount = 0;
  for (const v of variants) {
    if (mergedTo.has(v.new_node_id)) continue;
    const tgt = resolve(v.target_id);
    if (!repo.getNode(v.new_node_id) || !repo.getNode(tgt)) continue;
    if (v.new_node_id === tgt) continue;
    repo.addEdge({
      from_id: v.new_node_id,
      to_id: tgt,
      type: "relates_to",
      weight: 0.7,
      metadata: {
        from_phase: "dedupe_sweep",
        relation: "VARIANT_OF",
        rationale: v.rationale ?? null,
      },
    });
    variantCount++;
    repo.recordEvent({
      type: "dedupe_decision",
      node_id: v.new_node_id,
      payload: {
        sweep_id: sweepId,
        decision: "VARIANT_OF",
        target_id: tgt,
        rationale: v.rationale,
        from: "sweep",
      },
    });
  }
  logger.event("variants_applied", { count: variantCount });

  return {
    duplicates: duplicateCount,
    variants: variantCount,
    novel: novel.length,
    edgesRewritten,
    selfLoopsRemoved,
    chainCollapses,
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
