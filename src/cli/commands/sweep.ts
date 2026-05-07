import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { EmbeddingsRepo } from "../../graph/embeddings.js";
import { dedupeSweep } from "../../cycle/sweep.js";
import { MODELS } from "../../llm/models.js";
import { estimateUsd } from "../../llm/usage.js";
import { loadConfig } from "../config.js";

export async function dedupeSweepCmd(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);
  const embeddings = new EmbeddingsRepo(db, repo);

  const k =
    typeof flags["k"] === "string" ? Number.parseInt(flags["k"], 10) : undefined;
  const minSimilarity =
    typeof flags["min-similarity"] === "string"
      ? Number.parseFloat(flags["min-similarity"])
      : undefined;
  const chunkSize =
    typeof flags["chunk-size"] === "string"
      ? Number.parseInt(flags["chunk-size"], 10)
      : undefined;
  const skipBackfill = flags["skip-backfill"] === true;

  process.stdout.write(
    `running graph-wide dedupe sweep\n` +
      `  haiku:           ${MODELS.haiku}\n` +
      `  embed:           ${MODELS.embedding}\n` +
      `  k:               ${k ?? 4}\n` +
      `  min similarity:  ${minSimilarity ?? 0.78}\n` +
      `  chunk size:      ${chunkSize ?? 25}\n\n`,
  );

  const result = await dedupeSweep(repo, embeddings, {
    k,
    minSimilarity,
    chunkSize,
    skipBackfill,
  });

  const haikuUsd = estimateUsd(MODELS.haiku, result.haikuUsage);
  const embedUsd = estimateUsd(MODELS.embedding, {
    input_tokens: result.backfill.usageTokens,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });

  process.stdout.write(`✓ sweep complete\n`);
  process.stdout.write(`  sweep id:      ${result.sweepId}\n`);
  process.stdout.write(`  duration:      ${(result.durationMs / 1000).toFixed(1)}s\n\n`);
  process.stdout.write(`backfill:\n`);
  process.stdout.write(`  newly embedded: ${result.backfill.embedded}\n`);
  process.stdout.write(`  already had:    ${result.backfill.alreadyHad}\n`);
  process.stdout.write(`  embed tokens:   ${result.backfill.usageTokens}\n`);
  process.stdout.write(`  embed cost:     $${embedUsd.toFixed(4)}\n\n`);
  process.stdout.write(`dedupe:\n`);
  process.stdout.write(`  pairs scanned:  ${result.blocksConsidered}\n`);
  process.stdout.write(`  haiku chunks:   ${result.haikuChunks}\n`);
  process.stdout.write(`  duplicates:     ${result.applied.duplicates}\n`);
  process.stdout.write(`  variants:       ${result.applied.variants}\n`);
  process.stdout.write(`  novel:          ${result.applied.novel}\n`);
  if (result.applied.edgesRewritten) {
    process.stdout.write(`  edges fixed:    ${result.applied.edgesRewritten}\n`);
  }
  if (result.applied.chainCollapses) {
    process.stdout.write(`  chain collapses: ${result.applied.chainCollapses}\n`);
  }
  process.stdout.write(`  haiku tokens:   in=${result.haikuUsage.input_tokens} out=${result.haikuUsage.output_tokens}\n`);
  process.stdout.write(`  haiku cost:     $${haikuUsd.toFixed(4)}\n`);
  process.stdout.write(`  log:            ${result.logPath}\n\n`);
  process.stdout.write(`total est. cost: $${(haikuUsd + embedUsd).toFixed(4)}\n`);

  db.close();
}
