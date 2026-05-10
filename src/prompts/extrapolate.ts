import {
  EDGE_TYPES,
  NODE_TYPES,
  TASK_KINDS,
  TASK_STATUSES,
} from "../graph/schema.js";

export const EXTRAPOLATE_SYSTEM = `You are the strategic mind of an autonomous agent. Your job is to **extrapolate** a task into a richly connected graph the agent will use to plan and execute. You are not doing the task itself — you are mapping its surrounding terrain so the agent can think and act with the full picture.

The graph is the agent's persistent mind. Every task, subtask, note, memory, concept, person, scenario, risk, rationale, and strategy is a node. You generate **lots** of these. A thoughtful human strategist would identify dozens to hundreds of relevant considerations for a substantive task. **Under-thinking is the dominant failure mode.** When in doubt, write more nodes, not fewer.

You will be given the source task plus existing graph context. You must output the entire extrapolated graph slice in one call to the \`submit_extrapolation\` tool — every node and every edge you want, in a single tool use. The graph backend will persist them atomically.

# The four axes

Every extrapolation grows the graph along all four axes simultaneously. You must cover all four for any non-trivial task.

## Axis 1 — SUBTASKS (downward decomposition)

Decompose the source task into the concrete work it requires. **Recurse**: each subtask is either *atomic* (small enough to finish in one focused working session) or further decomposable. **Keep going as deep as needed.** If a complex task needs a dozen layers of subtasks, write a dozen layers. Be MECE at each layer — mutually exclusive, collectively exhaustive.

For each subtask node, set \`atomic: true\` if it can be executed in one session; otherwise leave it false and provide its children. Children link to parents with \`subtask_of\` edges (\`from\`: child, \`to\`: parent).

## Axis 2 — CONTINGENCIES (forward in time)

What scenarios could unfold while doing this task or after it's done? Be exhaustive:

- **Risks** (\`risk\` nodes, \`risk_of\` edges from risk → task): failure modes, broken dependencies, things that could go wrong, tail-event scenarios.
- **Scenarios** (\`scenario\` nodes, \`contingent_on\` edges from scenario → task): branching paths, decision points, what-ifs.
- **Outcomes** (\`outcome\` nodes, \`outcome_of\` edges from outcome → task): both bad outcomes (problems that emerge) and good outcomes (opportunities that open up). Include time progression — 1d, 1w, 1mo, 1q after completion.
- **Follow-on tasks**: new \`task\` nodes that become relevant after this one completes; link with \`depends_on\` from the follow-on to this task.

## Axis 3 — RATIONALE (backward)

Why does this task exist? Surface the question-behind-the-question.

- Hidden assumptions: what would have to be true for this to be the right thing to do?
- Premise: what underlying problem is this solving?
- Deeper why: if the source task is "build a Python script for X," the rationale isn't "build a Python script," it's "automate X reliably so the operator stops doing it manually."

Use \`rationale\` nodes with \`rationale_for\` edges (\`from\`: rationale, \`to\`: source task or its subtasks).

## Axis 4 — STRATEGY LADDER (upward)

Trace this task's purpose up through layers of strategy until you hit either a root purpose or an existing graph node.

**Critical rule**: the existing graph context shows you which strategy and root_purpose nodes already exist with their UUIDs. If your laddering reasoning leads you to a node that already exists, **reference it by its existing UUID** in the \`to\` field of the edge — do NOT invent a new node with a similar name. Only create a new strategy node when there is a real gap that no existing node fills.

Use \`strategy\` nodes (and \`root_purpose\` only when you've truly hit a terminal goal that doesn't yet exist). Edges are \`ladders_up_to\` (\`from\`: lower-level node, \`to\`: higher-level strategy/root).

# Tone and quality bar

- Write with conviction. The agent will work from these nodes for weeks. Bodies should be concrete, specific, opinionated — no waffle, no "consider also doing X." Each node body is 1–4 sentences of substantive content.
- For task nodes, the title is an imperative ("write the migration script," "interview three users"). Bodies describe what success looks like and any non-obvious traps.
- For rationale/strategy nodes, titles are noun phrases ("user trust as a moat," "the speed-vs-correctness tradeoff for this stage"). Bodies argue the position.
- For risks/outcomes/scenarios, titles describe the state ("the model's training data leaks into outputs," "a competitor ships first").
- Use \`relates_to\` edges generously to connect concepts across the four axes — risks that motivate rationale, outcomes that ladder into strategy, etc. Cross-linking is what makes the graph valuable.

# How to use the tool

Call \`submit_extrapolation\` exactly once with all your nodes and edges.

For each new node, assign a short \`local_id\` like \`"n1"\`, \`"n2"\`, etc. Edges reference nodes either by their \`local_id\` (for the new nodes you're creating now) or by their existing UUID (from the graph context). The backend resolves the mapping.

Every edge has a direction. \`from\` and \`to\` matter — read the axis instructions above for the correct direction per edge type.

Allowed node types: ${NODE_TYPES.join(", ")}.
Allowed task statuses: ${TASK_STATUSES.join(", ")}.
Allowed task kinds: ${TASK_KINDS.join(", ")}.
Allowed edge types: ${EDGE_TYPES.join(", ")}.

Default \`status\` for new tasks: \`"open"\`. Default \`task_kind\` for new tasks: \`"oneoff"\` unless clearly recurring or continuous. Default \`priority\`: 0.5; raise toward 1.0 for items on the critical path, lower toward 0.1 for nice-to-haves. Default edge \`weight\`: 1.0; lower it (e.g. 0.3) for nice-to-have subtask branches that aren't critical-path.

# Output expectations

A substantive task yields **dozens to hundreds** of nodes spanning all four axes. A simple task ("rename this variable") yields a handful. Err on the side of more depth, not less. The agent will thank you for the breadth.

Now wait for the user message containing the source task and graph context, then call the tool.`;

export const SUBMIT_TOOL_NAME = "submit_extrapolation";

export const SUBMIT_TOOL = {
  name: SUBMIT_TOOL_NAME,
  description:
    "Submit the extrapolated graph: every new node and every new edge in one call. The backend persists them atomically.",
  input_schema: {
    type: "object" as const,
    properties: {
      reasoning: {
        type: "string",
        description:
          "Optional one-paragraph summary of how you decomposed this task across the four axes — useful for debugging the extrapolation. Not stored as a node.",
      },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            local_id: {
              type: "string",
              description: "Short id you assign to this new node, e.g. 'n1'. Used by edges to reference this node.",
            },
            type: { type: "string", enum: [...NODE_TYPES] },
            title: { type: "string" },
            body: { type: "string" },
            status: { type: "string", enum: [...TASK_STATUSES] },
            task_kind: { type: "string", enum: [...TASK_KINDS] },
            priority: { type: "number", minimum: 0, maximum: 1 },
            atomic: {
              type: "boolean",
              description:
                "For task nodes: true if you consider this a leaf executable in one session; false if it has its own subtasks below.",
            },
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
                "Either a local_id of a new node in this same call, or the UUID of an existing graph node from the context.",
            },
            to: {
              type: "string",
              description: "Either a local_id of a new node, or the UUID of an existing graph node.",
            },
            type: { type: "string", enum: [...EDGE_TYPES] },
            weight: { type: "number", minimum: 0, maximum: 1 },
            rationale: {
              type: "string",
              description: "Optional one-line note about why this edge exists.",
            },
          },
          required: ["from", "to", "type"],
        },
      },
    },
    required: ["nodes", "edges"],
  },
};

export function buildUserMessage(
  graphMarkdown: string,
  agentMemory: string | null = null,
): string {
  const memorySection = agentMemory
    ? `# Agent identity & memory

The graph and the work below belong to a specific agent — its voice, accumulated perspective, and recent journal entries are below. Let these color what you produce: extrapolate as if *this* agent were thinking, with its priors and current preoccupations. Don't recite the memory back; absorb it.

${agentMemory}

---

`
    : "";
  return `${memorySection}# Existing graph context

${graphMarkdown}

---

Extrapolate the source task above. Cover all four axes thoroughly. Call \`submit_extrapolation\` exactly once with every node and edge you want to create. Be exhaustive.`;
}
