/**
 * Local embedding client backed by transformers.js. Runs ONNX models on CPU
 * with no API key. First call downloads the model (~25MB for the default
 * MiniLM-L6) into TRELLIS_LOCAL_MODELS_DIR (default data/models). Subsequent
 * calls use the cached weights.
 *
 * Default model: Xenova/all-MiniLM-L6-v2 — 384-dim, sentence-transformer
 * fine-tune, well-suited to dedupe-similarity work.
 */

import path from "node:path";

interface FeatureExtractionPipeline {
  (
    input: string | string[],
    options: { pooling: "mean" | "cls"; normalize: boolean },
  ): Promise<{ data: Float32Array | Float32Array[]; dims: number[] }>;
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let pipelineModel: string | null = null;

async function getPipeline(model: string): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise && pipelineModel === model) return pipelinePromise;
  pipelineModel = model;
  pipelinePromise = (async () => {
    const transformers = await import("@huggingface/transformers");
    const cacheDir =
      process.env.TRELLIS_LOCAL_MODELS_DIR ?? path.resolve("data/models");
    transformers.env.cacheDir = cacheDir;
    transformers.env.allowLocalModels = true;
    const extractor = await transformers.pipeline(
      "feature-extraction",
      model,
      {
        // Quantized weights are smaller and good enough for similarity.
        dtype: "q8",
      },
    );
    return extractor as unknown as FeatureExtractionPipeline;
  })();
  return pipelinePromise;
}

export interface LocalEmbedOptions {
  model: string;
  inputs: string[];
  /** Optional progress callback fired once per input embedded. */
  onProgress?: (done: number, total: number) => void;
}

export interface LocalEmbedResult {
  vectors: Float32Array[];
  dim: number;
  model: string;
  /** transformers.js doesn't bill tokens; reported as 0 for usage parity. */
  usage: { total_tokens: number };
}

export async function embed(
  opts: LocalEmbedOptions,
): Promise<LocalEmbedResult> {
  if (opts.inputs.length === 0) {
    return { vectors: [], dim: 0, model: opts.model, usage: { total_tokens: 0 } };
  }
  const sanitized = opts.inputs.map((s) =>
    typeof s === "string" && s.length > 24_000 ? s.slice(0, 24_000) : s,
  );
  const pipe = await getPipeline(opts.model);
  const vectors: Float32Array[] = [];
  // The pipeline accepts batches but the API surface for typed-array results
  // is cleaner one-at-a-time. For our scale (tens to low hundreds) the
  // overhead is negligible.
  for (let i = 0; i < sanitized.length; i++) {
    const text = sanitized[i] ?? "";
    const out = await pipe(text, { pooling: "mean", normalize: true });
    const data = Array.isArray(out.data) ? out.data[0] ?? new Float32Array() : out.data;
    vectors.push(new Float32Array(data));
    opts.onProgress?.(i + 1, sanitized.length);
  }
  const dim = vectors[0]?.length ?? 0;
  return {
    vectors,
    dim,
    model: opts.model,
    usage: { total_tokens: 0 },
  };
}
