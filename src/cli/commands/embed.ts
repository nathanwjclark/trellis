import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import {
  EmbeddingsRepo,
  backfillEmbeddings,
} from "../../graph/embeddings.js";
import { MODELS } from "../../llm/models.js";
import { estimateUsd } from "../../llm/usage.js";
import { loadConfig } from "../config.js";

export async function embedBackfill(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);
  const embeddings = new EmbeddingsRepo(db, repo);

  const model =
    typeof flags["model"] === "string" ? flags["model"] : MODELS.embedding;

  process.stdout.write(`backfilling embeddings under model: ${model}\n`);
  let lastTick = Date.now();
  const result = await backfillEmbeddings(embeddings, repo, {
    model,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastTick > 1500 || done === total) {
        process.stdout.write(`  ${done}/${total} embedded\n`);
        lastTick = now;
      }
    },
  });

  const usd = estimateUsd(model, {
    input_tokens: result.usageTokens,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });

  process.stdout.write(`\n✓ backfill complete\n`);
  process.stdout.write(`  newly embedded: ${result.embedded}\n`);
  process.stdout.write(`  already had:    ${result.alreadyHad}\n`);
  process.stdout.write(`  dim:            ${result.dim}\n`);
  process.stdout.write(`  embed tokens:   ${result.usageTokens}\n`);
  process.stdout.write(`  est. cost:      $${usd.toFixed(4)}\n`);

  db.close();
}
