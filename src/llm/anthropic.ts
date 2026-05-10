import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { CallLogger } from "./log.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface AnthropicCallOptions {
  /** Model id, e.g. "claude-opus-4-6" or "claude-haiku-4-5" */
  model: string;
  /** System prompt */
  system: string;
  /** User-turn messages */
  messages: MessageParam[];
  /** Tool definitions if you want forced tool use */
  tools?: Anthropic.Tool[];
  /** Force the model to call a specific tool */
  tool_choice?: { type: "tool"; name: string };
  /** Max output tokens. Default 8192. Push higher (up to 32k on Opus) for big extrapolations. */
  max_tokens?: number;
  /** Extended thinking, legacy "enabled" mode with a fixed budget.
   *  Deprecated by Anthropic in favor of `effort` (adaptive). Still
   *  works on Sonnet/Haiku as of 2026-05; rejected on Opus 4.7. */
  thinking_budget_tokens?: number;
  /** Adaptive-thinking effort level. Required (in place of
   *  `thinking_budget_tokens`) for Opus 4.7+. Sets
   *  `thinking: { type: "adaptive" }` and
   *  `output_config: { effort }` on the request. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Sampling temperature. Default 1. */
  temperature?: number;
  /** Optional per-call logger that captures stream events for postmortem. */
  logger?: CallLogger;
  /** Anthropic beta flags. e.g. ["context-1m-2025-08-07"] for the
   *  1M-token context window on supported models. Sent as
   *  anthropic-beta header. */
  betas?: string[];
}

export interface AnthropicCallResult {
  message: Message;
  /** Tool input if the response was a tool_use turn. */
  toolUse: { name: string; input: unknown } | null;
  /** Plain text content if any. */
  text: string;
  /** Token usage from the response. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY not set. Add it to .env or export it.",
      );
    }
    client = new Anthropic({ apiKey, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 2 });
  }
  return client;
}

export async function call(
  opts: AnthropicCallOptions,
): Promise<AnthropicCallResult> {
  const c = getClient();
  const max_tokens = opts.max_tokens ?? 8192;
  const params: Anthropic.MessageCreateParams = {
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    max_tokens,
    temperature: opts.temperature ?? 1,
  };
  if (opts.tools) params.tools = opts.tools;
  if (opts.tool_choice) params.tool_choice = opts.tool_choice;
  if (opts.effort) {
    // Adaptive thinking. The model chooses how much to think; effort
    // is the budget knob ("xhigh" = the deepest deliberation Anthropic
    // exposes short of "max"). Required for Opus 4.7+; Sonnet/Haiku
    // accept it too.
    (params as { thinking?: unknown }).thinking = { type: "adaptive" };
    (params as { output_config?: unknown }).output_config = {
      effort: opts.effort,
    };
    params.temperature = 1;
  } else if (opts.thinking_budget_tokens) {
    // Legacy thinking-budget mode. Deprecated by Anthropic but still
    // works on Sonnet/Haiku.
    (params as { thinking?: unknown }).thinking = {
      type: "enabled",
      budget_tokens: opts.thinking_budget_tokens,
    };
    params.temperature = 1;
  }

  // Stream when the response could be large — non-streaming requests with
  // thinking + tool_use can exceed proxy connection timeouts. The SDK's
  // .stream() helper assembles the final Message at the end.
  const shouldStream =
    !!opts.thinking_budget_tokens || max_tokens > 4096;

  const log = opts.logger;
  log?.event("request_start", {
    model: opts.model,
    max_tokens,
    thinking_budget_tokens: opts.thinking_budget_tokens ?? 0,
    streaming: shouldStream,
    tools: opts.tools?.map((t) => t.name) ?? [],
  });

  const requestOpts: { headers?: Record<string, string> } = {};
  if (opts.betas && opts.betas.length > 0) {
    requestOpts.headers = { "anthropic-beta": opts.betas.join(",") };
  }

  let resp: Message;
  if (shouldStream) {
    const stream = c.messages.stream(params, requestOpts);
    if (log) attachStreamLogger(stream, log);
    resp = (await stream.finalMessage()) as Message;
  } else {
    resp = (await c.messages.create(params, requestOpts)) as Message;
  }

  log?.event("response_complete", {
    stop_reason: resp.stop_reason,
    stop_sequence: resp.stop_sequence,
    usage: resp.usage,
    content_block_count: resp.content.length,
    content_types: resp.content.map((b) => b.type),
  });

  let toolUse: { name: string; input: unknown } | null = null;
  let text = "";
  for (const block of resp.content) {
    if (block.type === "tool_use") {
      const tu = block as ToolUseBlock;
      toolUse = { name: tu.name, input: tu.input };
    } else if (block.type === "text") {
      text += block.text;
    }
  }

  if (log) {
    log.event("parsed_response", {
      tool_use: toolUse
        ? {
            name: toolUse.name,
            input_keys:
              toolUse.input && typeof toolUse.input === "object"
                ? Object.keys(toolUse.input as Record<string, unknown>)
                : null,
            input_type: typeof toolUse.input,
          }
        : null,
      text_length: text.length,
    });
    if (toolUse) log.dump("tool_use_input", toolUse);
    if (text) log.dump("text_response", text);
  }

  return {
    message: resp,
    toolUse,
    text,
    usage: {
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      cache_creation_input_tokens:
        resp.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
    },
  };
}

type AnthropicStream = ReturnType<Anthropic["messages"]["stream"]>;

/**
 * Attach our logger to the SDK stream. The SDK exposes typed events for every
 * delta — text, thinking, input_json — so we can audit how the response was
 * actually assembled. We sample the volume of each stream rather than logging
 * every byte.
 */
function attachStreamLogger(stream: AnthropicStream, log: CallLogger): void {
  const counters = { text: 0, thinking: 0, input_json: 0, blocks: 0 };
  let lastSampleAt = Date.now();

  const sample = (kind: keyof typeof counters, size: number): void => {
    counters[kind] += size;
    const now = Date.now();
    if (now - lastSampleAt > 2000) {
      log.event("stream_progress", { ...counters });
      lastSampleAt = now;
    }
  };

  stream.on("connect", () => log.event("stream_connect"));
  stream.on("error", (err) =>
    log.event("stream_error", {
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  stream.on("text", (delta: string) => sample("text", delta.length));
  stream.on("inputJson", (partialJson: string) =>
    sample("input_json", partialJson.length),
  );
  // streamEvent is the catch-all — capture thinking deltas and block lifecycle.
  stream.on("streamEvent", (event) => {
    counters.blocks++;
    if (event.type === "content_block_start") {
      log.event("block_start", {
        index: event.index,
        type: event.content_block.type,
        ...(event.content_block.type === "tool_use"
          ? { tool_name: event.content_block.name, tool_id: event.content_block.id }
          : {}),
      });
    } else if (event.type === "content_block_stop") {
      log.event("block_stop", { index: event.index });
    } else if (
      event.type === "content_block_delta" &&
      event.delta.type === "thinking_delta"
    ) {
      sample("thinking", event.delta.thinking.length);
    } else if (event.type === "message_delta") {
      log.event("message_delta", {
        stop_reason: event.delta.stop_reason,
        usage: event.usage,
      });
    }
  });
  stream.on("end", () => log.event("stream_end", { ...counters }));
}
