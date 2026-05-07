/**
 * Dedupe-phase prompt. Runs *after* extrapolation + index. For every
 * newly-created node, we computed top-K embedding-nearest existing nodes;
 * the LLM decides whether each new node is a duplicate, a variant, or
 * genuinely novel.
 *
 * The model receives one prompt that lists every new node alongside its
 * candidate set, and returns one decision per new node.
 */

export const DEDUPE_SYSTEM = `You are the deduplication phase of an autonomous agent's graph-native task substrate. The graph is the agent's persistent mind. New nodes are constantly being created, and you keep the graph clean by reconciling near-duplicates.

You receive a list of newly-created nodes. For each one we've already pulled the **top embedding-nearest existing nodes** from the rest of the graph as candidates. Your job is to decide, per new node, one of:

- **DUPLICATE_OF <existing_uuid>** — the new node and the existing node represent the same thing. Edges on the new node will be redirected to the existing node and the new node deleted. Use this when the two nodes are functionally interchangeable. Be conservative: only when titles + bodies clearly describe the same thing.
- **VARIANT_OF <existing_uuid>** — closely related but legitimately distinct. The new node is kept, and a \`relates_to\` edge is added between it and the existing node. Use this generously — it links the graph without losing information.
- **NOVEL** — neither a duplicate nor a strong variant. The new node stands on its own.

# Disambiguation rules

- **Same concept, different context = NOT a duplicate.** "Research SQLite for Trellis storage" and "Research SQLite for project Foo" are *not* duplicates even if titles overlap. Their context (which task they're under) makes them distinct.
- **Type mismatch = strong signal against duplicate.** A \`risk\` and a \`concept\` with the same title are likely VARIANT_OF, not DUPLICATE_OF. Same with a \`task\` vs a \`strategy\`.
- **Generic vs specific = VARIANT_OF.** "Database" (concept) and "SQLite local-first storage" (concept) — variants, not duplicates.
- **Near-paraphrase of a recently-created sibling = DUPLICATE_OF.** When extrapolation produced two nodes saying nearly the same thing under the same parent, the second is a duplicate of the first.
- When in doubt, prefer VARIANT_OF over DUPLICATE_OF. Information loss from a wrong duplicate decision is permanent; a redundant relates_to edge is harmless.

# Output

Call \`submit_dedupe_decisions\` exactly once with one decision per new node. The new node's UUID is given to you in the input — emit it as \`new_node_id\`.

If a new node has no plausible candidate, emit \`{ "new_node_id": "...", "decision": "NOVEL" }\`.

Always include a brief \`rationale\` (one sentence) explaining the call.`;

export const DEDUPE_TOOL_NAME = "submit_dedupe_decisions";

export const DEDUPE_TOOL = {
  name: DEDUPE_TOOL_NAME,
  description:
    "Submit DUPLICATE_OF / VARIANT_OF / NOVEL decisions for every new node in one call.",
  input_schema: {
    type: "object" as const,
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            new_node_id: { type: "string", description: "UUID of the new node being judged." },
            decision: {
              type: "string",
              enum: ["DUPLICATE_OF", "VARIANT_OF", "NOVEL"],
            },
            target_id: {
              type: "string",
              description:
                "UUID of the existing node, required for DUPLICATE_OF and VARIANT_OF.",
            },
            rationale: { type: "string" },
          },
          required: ["new_node_id", "decision"],
        },
      },
    },
    required: ["decisions"],
  },
};

export interface CandidateBlock {
  newNodeId: string;
  newType: string;
  newTitle: string;
  newBody: string;
  candidates: { id: string; type: string; title: string; body: string; similarity: number }[];
}

export function buildDedupeUserMessage(blocks: CandidateBlock[]): string {
  if (blocks.length === 0) {
    return "_(No new nodes had candidates. Submit an empty decisions array.)_";
  }
  const sections: string[] = [];
  for (const b of blocks) {
    const cands =
      b.candidates.length === 0
        ? "  _(no candidates above similarity threshold — this is almost certainly NOVEL)_"
        : b.candidates
            .map(
              (c, i) =>
                `  ${i + 1}. **${c.type}** \`${c.id}\` — _${c.title}_  (sim=${c.similarity.toFixed(3)})\n     ${truncate(c.body, 320)}`,
            )
            .join("\n");
    sections.push(
      `## new node \`${b.newNodeId}\`  (type: ${b.newType})\n` +
        `**Title**: ${b.newTitle}\n` +
        `**Body**: ${truncate(b.newBody, 600)}\n\n` +
        `**Candidates** (embedding-nearest existing nodes):\n${cands}`,
    );
  }
  return (
    `Decide DUPLICATE_OF / VARIANT_OF / NOVEL for each new node below. Call \`submit_dedupe_decisions\` exactly once.\n\n` +
    sections.join("\n\n---\n\n")
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
