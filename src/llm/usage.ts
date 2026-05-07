import type { Repo } from "../graph/repo.js";

/**
 * Approximate per-million-token pricing in USD. Used only for visibility — not
 * for enforcement. Override via env (TRELLIS_PRICE_<MODEL>_INPUT, _OUTPUT,
 * _CACHE_WRITE, _CACHE_READ).
 */
const PRICE: Record<
  string,
  { input: number; output: number; cache_write: number; cache_read: number }
> = {
  "claude-opus-4-6": { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-opus-4-7": { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  // Voyage embedding pricing (per 1M tokens, input only).
  "voyage-3.5": { input: 0.06, output: 0, cache_write: 0, cache_read: 0 },
  "voyage-3.5-lite": { input: 0.02, output: 0, cache_write: 0, cache_read: 0 },
  "voyage-3-large": { input: 0.18, output: 0, cache_write: 0, cache_read: 0 },
  "voyage-3": { input: 0.06, output: 0, cache_write: 0, cache_read: 0 },
  // Local transformers.js — free.
  "Xenova/all-MiniLM-L6-v2": { input: 0, output: 0, cache_write: 0, cache_read: 0 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function estimateUsd(model: string, usage: Usage): number {
  const p = PRICE[model];
  if (!p) return 0;
  const m = 1_000_000;
  return (
    (usage.input_tokens * p.input) / m +
    (usage.output_tokens * p.output) / m +
    (usage.cache_creation_input_tokens * p.cache_write) / m +
    (usage.cache_read_input_tokens * p.cache_read) / m
  );
}

export function recordUsage(
  repo: Repo,
  args: {
    model: string;
    purpose: string;
    cycle_id?: string;
    node_id?: string;
    usage: Usage;
    durationMs?: number;
  },
): void {
  repo.recordEvent({
    type: "llm_call",
    node_id: args.node_id ?? null,
    payload: {
      model: args.model,
      purpose: args.purpose,
      cycle_id: args.cycle_id,
      input_tokens: args.usage.input_tokens,
      output_tokens: args.usage.output_tokens,
      cache_creation_input_tokens: args.usage.cache_creation_input_tokens,
      cache_read_input_tokens: args.usage.cache_read_input_tokens,
      usd_estimated: estimateUsd(args.model, args.usage),
      duration_ms: args.durationMs,
    },
  });
}

/** Sum estimated USD spend across `llm_call` events in the last `windowMs`. */
export function spendInWindow(repo: Repo, windowMs: number): number {
  const since = Date.now() - windowMs;
  const events = repo.recentEvents(10_000).filter(
    (e) =>
      e.type === "llm_call" &&
      e.created_at >= since,
  );
  let total = 0;
  for (const e of events) {
    const usd = (e.payload.usd_estimated as number | undefined) ?? 0;
    total += usd;
  }
  return total;
}
