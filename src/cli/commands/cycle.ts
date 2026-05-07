import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { EmbeddingsRepo } from "../../graph/embeddings.js";
import { runCycle, type CyclePhase } from "../../cycle/orchestrate.js";
import { estimateUsd } from "../../llm/usage.js";
import { MODELS } from "../../llm/models.js";
import { loadConfig } from "../config.js";

const ALL_PHASES: CyclePhase[] = ["extrapolate", "index", "dedupe"];

export async function cycle(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const nodeId = typeof flags["node"] === "string" ? flags["node"] : null;
  if (!nodeId) {
    throw new Error(
      "cycle requires --node <node-id>. Run `trellis status` to find ids.",
    );
  }

  const phases = parsePhases(flags["phases"]);

  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);
  const embeddings = new EmbeddingsRepo(db, repo);

  const source = repo.getNode(nodeId);
  if (!source) {
    db.close();
    throw new Error(`node ${nodeId} not found`);
  }

  process.stdout.write(
    `cycle on: ${source.type} ${source.id} — ${source.title}\n`,
  );
  process.stdout.write(`phases:    ${phases.join(" → ")}\n`);
  process.stdout.write(`models:    reasoning=${MODELS.reasoning}  haiku=${MODELS.haiku}  embed=${MODELS.embedding}\n\n`);

  const summary = await runCycle(repo, embeddings, nodeId, {
    phases,
    extrapolate: {
      maxTokens:
        typeof flags["max-tokens"] === "string"
          ? Number.parseInt(flags["max-tokens"], 10)
          : undefined,
      thinkingBudget:
        typeof flags["thinking-budget"] === "string"
          ? Number.parseInt(flags["thinking-budget"], 10)
          : undefined,
    },
  });

  process.stdout.write(`✓ cycle complete\n`);
  process.stdout.write(`  cycle id:     ${summary.cycleId}\n`);
  process.stdout.write(`  total time:   ${(summary.durationMs / 1000).toFixed(1)}s\n\n`);

  let totalUsd = 0;

  if (summary.phases.extrapolate) {
    const e = summary.phases.extrapolate;
    const usd = estimateUsd(MODELS.reasoning, e.usage);
    totalUsd += usd;
    process.stdout.write(`extrapolate (${(e.durationMs / 1000).toFixed(1)}s):\n`);
    process.stdout.write(`  new nodes:    ${e.newNodes}\n`);
    process.stdout.write(`  new edges:    ${e.newEdges}\n`);
    if (e.skippedEdges) process.stdout.write(`  skipped:      ${e.skippedEdges}\n`);
    process.stdout.write(`  tokens:       in=${e.usage.input_tokens} out=${e.usage.output_tokens}\n`);
    process.stdout.write(`  cost:         $${usd.toFixed(4)}\n`);
    process.stdout.write(`  log:          ${e.logPath}\n\n`);
  }

  if (summary.phases.index) {
    const i = summary.phases.index;
    const usd = estimateUsd(MODELS.haiku, i.usage);
    totalUsd += usd;
    process.stdout.write(`index (${(i.durationMs / 1000).toFixed(1)}s):\n`);
    process.stdout.write(`  new nodes:    ${i.newNodes}\n`);
    process.stdout.write(`  new edges:    ${i.newEdges}\n`);
    if (i.skippedEdges) process.stdout.write(`  skipped:      ${i.skippedEdges}\n`);
    process.stdout.write(`  tokens:       in=${i.usage.input_tokens} out=${i.usage.output_tokens}\n`);
    process.stdout.write(`  cost:         $${usd.toFixed(4)}\n\n`);
  }

  if (summary.phases.dedupe) {
    const d = summary.phases.dedupe;
    const haikuUsd = estimateUsd(MODELS.haiku, d.usage);
    totalUsd += haikuUsd;
    process.stdout.write(`dedupe (${(d.durationMs / 1000).toFixed(1)}s):\n`);
    if (d.skipReason) {
      process.stdout.write(`  skipped:      ${d.skipReason}\n\n`);
    } else {
      process.stdout.write(`  embedded:     ${d.embeddedNodeIds.length}\n`);
      process.stdout.write(`  duplicates:   ${d.applied.duplicates}\n`);
      process.stdout.write(`  variants:     ${d.applied.variants}\n`);
      process.stdout.write(`  novel:        ${d.applied.novel}\n`);
      if (d.applied.edgesRewritten) process.stdout.write(`  edges fixed:  ${d.applied.edgesRewritten}\n`);
      process.stdout.write(`  haiku tokens: in=${d.usage.input_tokens} out=${d.usage.output_tokens}\n`);
      process.stdout.write(`  embed tokens: ${d.embeddingUsageTokens}\n`);
      process.stdout.write(`  cost:         $${haikuUsd.toFixed(4)}\n\n`);
    }
  }

  process.stdout.write(`total est. cost: $${totalUsd.toFixed(4)}\n`);

  db.close();
}

function parsePhases(flag: string | boolean | undefined): CyclePhase[] {
  if (typeof flag !== "string") return ALL_PHASES;
  const parts = flag
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as CyclePhase[];
  for (const p of parts) {
    if (!ALL_PHASES.includes(p)) {
      throw new Error(`unknown phase: ${p}. Allowed: ${ALL_PHASES.join(", ")}`);
    }
  }
  return parts;
}
