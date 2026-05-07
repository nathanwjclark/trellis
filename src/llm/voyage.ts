/**
 * Voyage AI embedding client. Anthropic's recommended embedding provider.
 * Uses plain fetch — Voyage's HTTP API is small enough that a dedicated SDK
 * isn't worth the dependency.
 *
 * Docs: https://docs.voyageai.com/reference/embeddings-api
 */

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

export interface VoyageEmbedOptions {
  /** e.g. "voyage-3-large", "voyage-3", "voyage-3.5", "voyage-3.5-lite". */
  model: string;
  /** Up to 1000 inputs per request per Voyage limits. */
  inputs: string[];
  /** Optional input_type hint — "document" for stored content, "query" for searches. */
  input_type?: "document" | "query";
}

export interface VoyageEmbedResult {
  vectors: Float32Array[];
  dim: number;
  model: string;
  usage: { total_tokens: number };
}

export async function embed(opts: VoyageEmbedOptions): Promise<VoyageEmbedResult> {
  if (opts.inputs.length === 0) {
    return { vectors: [], dim: 0, model: opts.model, usage: { total_tokens: 0 } };
  }
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY not set. Required for embeddings (dedupe phase). Get one free at https://www.voyageai.com/.",
    );
  }
  // Cap individual inputs at ~32k chars to stay well under model token caps.
  const sanitized = opts.inputs.map((s) =>
    typeof s === "string" && s.length > 24_000 ? s.slice(0, 24_000) : s,
  );

  const body: Record<string, unknown> = {
    model: opts.model,
    input: sanitized,
  };
  if (opts.input_type) body.input_type = opts.input_type;

  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Voyage embeddings ${resp.status}: ${text || resp.statusText}`);
  }
  const json = (await resp.json()) as {
    data: { embedding: number[]; index: number }[];
    usage: { total_tokens: number };
    model: string;
  };

  const vectors = json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => Float32Array.from(d.embedding));
  const dim = vectors[0]?.length ?? 0;
  return {
    vectors,
    dim,
    model: json.model ?? opts.model,
    usage: { total_tokens: json.usage?.total_tokens ?? 0 },
  };
}
