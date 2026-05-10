/**
 * Model identifiers used throughout Trellis. Override via env vars when you
 * want to swap models without code changes.
 */

export const MODELS = {
  /** Scheduler + dedupe-decision. Sonnet 4.6 is the small-fast workhorse
   *  here — the scheduler runs every iteration, so latency matters. */
  reasoning: process.env.TRELLIS_MODEL_REASONING ?? "claude-sonnet-4-6",
  /** Extrapolation: deeper, slower. Opus with 1M context (beta header
   *  enabled in extrapolate.ts) so the agent can see the entire graph
   *  even at hundreds of nodes, plus very-high thinking budget. */
  extrapolation: process.env.TRELLIS_MODEL_EXTRAPOLATION ?? "claude-opus-4-7",
  /** Strategy synthesis pass (every N iterations). Same family as
   *  extrapolation but distinguished as a separate knob so the depth
   *  budget can be turned up further without affecting normal cycles. */
  strategy: process.env.TRELLIS_MODEL_STRATEGY ?? "claude-opus-4-7",
  /** Fast/cheap: index extraction, batch operations. */
  haiku: process.env.TRELLIS_MODEL_HAIKU ?? "claude-haiku-4-5",
  /** Embeddings. Default runs locally via transformers.js (no API key, ~25MB
   *  model auto-downloaded on first use, 384-dim). Override to a "voyage-*"
   *  model + set VOYAGE_API_KEY for higher-quality cloud embeddings. */
  embedding: process.env.TRELLIS_MODEL_EMBEDDING ?? "Xenova/all-MiniLM-L6-v2",
} as const;

/** Anthropic beta flags. The 1M-context flag is required for Opus to
 *  ingest the full graph (>200K tokens) plus identity memory. */
export const ANTHROPIC_BETAS = {
  context_1m: "context-1m-2025-08-07",
};
