import { v4 as uuid } from "uuid";
import type { Repo } from "../graph/repo.js";
import { EmbeddingsRepo } from "../graph/embeddings.js";
import type { Node } from "../graph/schema.js";
import { extrapolate, type ExtrapolateOptions } from "./extrapolate.js";
import { indexPhase, type IndexOptions } from "./index_phase.js";
import { deduplicate, type DedupeOptions, type DedupeResult } from "./deduplicate.js";
import { openCallLogger } from "../llm/log.js";

export type CyclePhase = "extrapolate" | "index" | "dedupe";

export interface CycleOptions {
  /** Phases to run, in order. Default all three. */
  phases?: CyclePhase[];
  extrapolate?: ExtrapolateOptions;
  index?: IndexOptions;
  dedupe?: DedupeOptions;
}

export interface CycleSummary {
  cycleId: string;
  sourceId: string;
  durationMs: number;
  phases: {
    extrapolate?: {
      newNodes: number;
      newEdges: number;
      skippedEdges: number;
      durationMs: number;
      reasoning: string | null;
      logPath: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      };
    };
    index?: {
      newNodes: number;
      newEdges: number;
      skippedEdges: number;
      durationMs: number;
      reasoning: string | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      };
    };
    dedupe?: DedupeResult;
  };
}

export async function runCycle(
  repo: Repo,
  embeddings: EmbeddingsRepo,
  sourceId: string,
  opts: CycleOptions = {},
): Promise<CycleSummary> {
  const cycleId = uuid();
  const startedAt = Date.now();
  const phases = opts.phases ?? ["extrapolate", "index", "dedupe"];

  const summary: CycleSummary = {
    cycleId,
    sourceId,
    durationMs: 0,
    phases: {},
  };

  let extrapolatedNodes: Node[] = [];
  let indexedNodes: Node[] = [];
  let extrapolateContextMarkdown = "";

  if (phases.includes("extrapolate")) {
    const ext = await extrapolate(repo, sourceId, {
      ...opts.extrapolate,
      cycleId,
    });
    extrapolateContextMarkdown = ext.graphContextMarkdown;
    extrapolatedNodes = ext.newNodeIds
      .map((id) => repo.getNode(id))
      .filter((n): n is Node => n !== null);
    summary.phases.extrapolate = {
      newNodes: ext.newNodeIds.length,
      newEdges: ext.newEdgeIds.length,
      skippedEdges: ext.skippedEdges.length,
      durationMs: ext.durationMs,
      reasoning: ext.reasoning,
      logPath: ext.logPath,
      usage: ext.usage,
    };
  }

  if (phases.includes("index")) {
    const source = repo.getNode(sourceId);
    if (!source) throw new Error(`source node ${sourceId} not found`);

    // If extrapolate didn't run this cycle, build context fresh.
    let contextMarkdown = extrapolateContextMarkdown;
    if (!contextMarkdown) {
      const { assembleContext } = await import("./context.js");
      contextMarkdown = assembleContext(repo, sourceId).markdown;
    }

    const idxLogger = openCallLogger({ cycleId, purpose: "index" });
    try {
      const idx = await indexPhase(
        repo,
        {
          cycleId,
          source,
          graphContextMarkdown: contextMarkdown,
          newNodes: extrapolatedNodes,
          logger: idxLogger,
        },
        opts.index,
      );
      indexedNodes = idx.newNodeIds
        .map((id) => repo.getNode(id))
        .filter((n): n is Node => n !== null);
      summary.phases.index = {
        newNodes: idx.newNodeIds.length,
        newEdges: idx.newEdgeIds.length,
        skippedEdges: idx.skippedEdges.length,
        durationMs: idx.durationMs,
        reasoning: idx.reasoning,
        usage: idx.usage,
      };
    } finally {
      idxLogger.close();
    }
  }

  if (phases.includes("dedupe")) {
    const source = repo.getNode(sourceId);
    if (!source) throw new Error(`source node ${sourceId} not found`);
    const allNew = [...extrapolatedNodes, ...indexedNodes];
    const dedupLogger = openCallLogger({ cycleId, purpose: "dedupe" });
    try {
      const dedupe = await deduplicate(
        repo,
        embeddings,
        {
          cycleId,
          source,
          newNodes: allNew,
          logger: dedupLogger,
        },
        opts.dedupe,
      );
      summary.phases.dedupe = dedupe;
    } finally {
      dedupLogger.close();
    }
  }

  summary.durationMs = Date.now() - startedAt;
  repo.recordEvent({
    type: "cycle_completed",
    node_id: sourceId,
    payload: {
      cycle_id: cycleId,
      phases: phases,
      duration_ms: summary.durationMs,
    },
  });
  return summary;
}
