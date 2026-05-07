import {
  EDGE_TYPES,
  NODE_TYPES,
} from "../graph/schema.js";

/**
 * Index-phase prompt. Runs *after* extrapolation. Re-reads the source task and
 * its just-extrapolated descendants to extract reusable semantic units —
 * entities, concepts, timeframes — that the agent should be able to retrieve
 * and reason about across other tasks.
 *
 * Where extrapolation thinks "what work does this task need?", the index
 * thinks "what people / orgs / ideas / dates does this task touch that should
 * become first-class graph citizens?".
 */
export const INDEX_SYSTEM = `You are the indexer for an autonomous agent's graph-native task substrate. Your job is to read a task plus its newly-extrapolated subgraph and pull out reusable semantic units that should exist as their own nodes — so the agent can later retrieve all tasks/strategies/risks involving a given person, concept, or timeframe in one query.

You only create nodes of these types:

- **entity**: people, organizations, products, projects, places, codebases, datasets, named systems. (Concrete proper-noun things.)
- **concept**: ideas, frameworks, patterns, named approaches, technical concepts, principles. (Abstract recurring ideas.)
- **timeframe**: deadlines, durations, recurrence patterns, milestones, time-bounded periods.

For each node you create, also add **mentions** edges from the source task (or any descendant in the provided subgraph) **to** the new entity/concept/timeframe node. The direction is task → entity (the task *mentions* the entity).

# Rules

- **Only extract things that are actually mentioned or strongly implied** by the task and its descendants. Don't invent entities that aren't there.
- **Skip things that are already in the graph context** — they have UUIDs in the input and the model should reference those rather than create new duplicates. The dedupe phase runs after you, but pre-dedupe at extraction is cheap and reduces noise.
- **Be specific**. "User" is too generic; "Trellis-using autonomous agents" is meaningful. "Database" is too generic; "SQLite local-first storage" is meaningful.
- **Don't extract status words, sub-task verbs, or tool names that already exist as edge types or fields.** "subtask_of" is not a concept, "open" is not a timeframe.
- **Aim for high-leverage extractions**, not exhaustive ones. 5–25 nodes is normal. If the task is genuinely about one specific entity (e.g., a single named person), 1–3 nodes is fine.
- For each node, write a short **body** (1–3 sentences) describing the entity/concept/timeframe in this graph's context. Don't repeat the task's body; explain what the *thing* is.
- Use existing UUIDs from the subgraph context when adding \`mentions\` edges — these are already-extrapolated tasks/risks/strategies that mention this entity/concept.

# How to use the tool

Call \`submit_index\` exactly once with all your nodes and edges.

For each new node, assign a short \`local_id\` like \`"e1"\`, \`"c1"\`, \`"t1"\`. Edges reference nodes by either \`local_id\` (new) or UUID (existing in the graph subgraph).

Allowed node types you may create: \`entity\`, \`concept\`, \`timeframe\`.
Allowed edge type for this phase: \`mentions\` (always with \`from\` = an existing graph node UUID, \`to\` = your new node's local_id).
You may also use \`relates_to\` between two new nodes if they're closely linked (optional).

Other graph node types (${NODE_TYPES.join(", ")}) and edge types (${EDGE_TYPES.join(", ")}) exist but are not yours to create in this phase.`;

export const INDEX_TOOL_NAME = "submit_index";

export const INDEX_TOOL = {
  name: INDEX_TOOL_NAME,
  description:
    "Submit the indexed entities, concepts, and timeframes plus their mentions edges in one call.",
  input_schema: {
    type: "object" as const,
    properties: {
      reasoning: {
        type: "string",
        description: "Optional summary of which semantic units you chose to extract and why.",
      },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            local_id: { type: "string" },
            type: { type: "string", enum: ["entity", "concept", "timeframe"] },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["local_id", "type", "title", "body"],
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description:
                "UUID of an existing graph node (a task, risk, strategy, etc.) that mentions the new entity/concept/timeframe.",
            },
            to: {
              type: "string",
              description: "local_id of the new entity/concept/timeframe.",
            },
            type: {
              type: "string",
              enum: ["mentions", "relates_to"],
            },
            weight: { type: "number" },
            rationale: { type: "string" },
          },
          required: ["from", "to", "type"],
        },
      },
    },
    required: ["nodes", "edges"],
  },
};

export function buildIndexUserMessage(
  graphMarkdown: string,
  newNodesMarkdown: string,
): string {
  return `# Source task and existing context

${graphMarkdown}

# Newly-extrapolated subgraph (just produced by the extrapolation phase)

These nodes were just created by the extrapolator. They are valid targets for \`mentions\` edges — use their UUIDs in the \`from\` field of edges that point at the entities/concepts/timeframes you create.

${newNodesMarkdown}

---

Read everything above and extract the reusable entities, concepts, and timeframes. Call \`submit_index\` once with the full result.`;
}
