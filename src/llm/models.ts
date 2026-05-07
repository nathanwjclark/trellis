/**
 * Model identifiers used throughout Trellis. Override via env vars when you
 * want to swap models without code changes.
 */

export const MODELS = {
  /** Heavy reasoning: extrapolation and dedupe-decision. Using Sonnet 4.6
   *  rather than Opus for faster turnaround; switch back via env if depth
   *  becomes a problem. */
  reasoning: process.env.TRELLIS_MODEL_REASONING ?? "claude-sonnet-4-6",
  /** Fast/cheap: index extraction, batch operations. */
  haiku: process.env.TRELLIS_MODEL_HAIKU ?? "claude-haiku-4-5",
  /** Embeddings. Default runs locally via transformers.js (no API key, ~25MB
   *  model auto-downloaded on first use, 384-dim). Override to a "voyage-*"
   *  model + set VOYAGE_API_KEY for higher-quality cloud embeddings. */
  embedding: process.env.TRELLIS_MODEL_EMBEDDING ?? "Xenova/all-MiniLM-L6-v2",
} as const;
