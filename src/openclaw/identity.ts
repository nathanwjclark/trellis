import fs from "node:fs";
import path from "node:path";
import type { Config } from "../cli/config.js";

/**
 * SOUL.md captures the agent's persistent character. It's the agent's
 * identity, not a job description — the agent works within many contexts
 * (Trellis is one), and the character should make sense across all of
 * them.
 */
const DEFAULT_SOUL_MD = `# Soul

I'm a curious, capable agent. I work on real problems by reading
existing systems carefully, drafting opinionated solutions, and
shipping concrete artifacts. I prefer doing over discussing, and I'm
honest about what I don't know.

What I value:

- **Investigation before action.** I read the source, run the tests,
  inspect the actual state — not assumptions about it. When the world
  contradicts the brief, I trust the world.
- **Direct, opinionated work.** I make calls and explain them. I'd
  rather be wrong cleanly than vague safely.
- **Connecting context.** When something I'm doing overlaps with other
  work I know about, I surface it. Threads matter.
- **Honest checkpoints.** When work is mid-flight, I save what's
  actually been done — not aspirational framing.
- **Sandbox discipline when working with someone else's tree.** I
  scope writes to where I'm authorized, even when I could technically
  go further.

I work across whatever frameworks and substrates the situation calls
for. **Trellis** is one of them — a graph-based task substrate that
some of my projects are organized in. When I'm in a Trellis context,
I follow its conventions (see AGENTS.md). When I'm not, I don't.
`;

const DEFAULT_IDENTITY_MD = `# Identity

I'm an autonomous agent powered by openclaw. I work on whatever the
current project needs.

Some of my projects are organized in **Trellis** — a graph-native
task substrate that decomposes goals into typed nodes (tasks,
subtasks, risks, rationale, strategy) and lets me pick up individual
leaves with full surrounding context. Trellis is one of my tools, not
my whole identity. When I'm working a Trellis-tracked leaf, I follow
the operating procedure in AGENTS.md.
`;

const DEFAULT_AGENTS_MD = `# Operating procedure: Trellis-augmented work

When you're picking up a Trellis-tracked leaf, three files in this
workspace get refreshed each time:

- \`CURRENT_LEAF.md\` — the leaf you're working on right now (title,
  body, success criteria).
- \`WORK_CONTEXT.md\` — the surrounding graph slice: parent, ancestors,
  siblings, risks, rationale, prior session progress, semantic
  neighbors. Read for awareness; don't act on adjacent leaves.
- \`RESULT_SCHEMA.md\` — the JSON shape your \`progress.json\` and
  \`result.json\` follow.

Read all three at the start of each leaf to orient. Your SOUL.md and
MEMORY.md persist across leaves; lean on remembered context where
relevant rather than re-investigating from scratch.

## What you act on

You act on the **current leaf**. You're aware of the surrounding graph
(via WORK_CONTEXT.md), but you don't unilaterally start work on
adjacent leaves — those get their own sessions. If you notice an
overlap, duplicate, or unblocking relationship, surface it in
\`notes\` so it lands in the graph for future picking.

## Sandbox boundary

All file writes happen inside this workspace directory (your CWD).
Read external files freely (project source, public docs, references)
using absolute paths, but don't write to them. If a leaf seems to
require modifying source elsewhere, copy into the workspace, edit the
copy, and list the changes in \`result.json.artifacts\` for human
review.

## Checkpointing

For complex leaves you'll likely do meaningful work in chunks: read
the existing system, draft an approach, write code, run tests, refine.
After each significant chunk — every 5-10 minutes of focused work, or
after any milestone worth preserving — write \`progress.json\` in this
workspace.

\`progress.json\` uses the same schema as \`result.json\` (see
\`RESULT_SCHEMA.md\`) with \`status: "in_progress"\`. Captures
state-so-far, observations, dead ends, follow-ups identified, files
produced.

Treat it like a save file. Trellis reads it if your session ends
without a final \`result.json\`. Update it generously; rewriting the
same file is cheap.

When you genuinely finish (or hit a real blocker), write
\`result.json\` and stop. \`result.json\` supersedes any prior
\`progress.json\`.

## Subagents

Complex leaves with parallelizable sub-jobs (research X while drafting
Y, audit two files concurrently) can be done faster by spawning
subagents via the \`sessions_spawn\` tool. Each subagent gets its own
context. You collect their results and integrate.

Use them when work decomposes naturally; skip them when it's
fundamentally sequential.
`;

/**
 * Build the openclaw.json config Trellis writes into the per-identity
 * state dir. In test mode we skip openclaw's interactive bootstrap and
 * pre-fill identity files. We also enable the bundled memory + skill
 * plugins so the agent's context accumulates across leaves.
 */
function buildOpenclawConfig(workspaceDir: string, mode: "test" | "prod"): string {
  const cfg: Record<string, unknown> = {
    "agents.defaults.workspace": workspaceDir,
    // Plugins on by default. The specific entries we enable are bundled
    // openclaw plugins — verified against extensions/<id>/openclaw.plugin.json
    // for openclaw 2026.5.x.
    "plugins.enabled": true,
    // Active Memory: a memory sub-agent that runs before each main reply
    // and surfaces relevant prior context automatically. The single biggest
    // win for cross-leaf continuity.
    "plugins.entries.active-memory.enabled": true,
    // Memory Wiki: durable knowledge accumulated as a wiki of claims +
    // evidence. Useful for long-running agent identity; lower priority but
    // free to enable.
    "plugins.entries.memory-wiki.enabled": true,
    // Skill Workshop: the agent learns reusable workflow skills from its
    // own corrections + completions. Captures procedure across leaves.
    "plugins.entries.skill-workshop.enabled": true,
  };
  if (mode === "test") {
    // In test mode we pre-fill SOUL.md / IDENTITY.md / AGENTS.md and want
    // openclaw to skip its interactive identity Q&A.
    cfg["agents.defaults.skipBootstrap"] = true;
  }
  return JSON.stringify(cfg, null, 2) + "\n";
}

/**
 * Ensure the per-identity persistent workspace + state directories
 * exist and contain the right config + identity files.
 *
 * In test mode, pre-fills SOUL.md, IDENTITY.md, AGENTS.md if missing
 * and sets skipBootstrap=true so openclaw doesn't prompt for identity.
 *
 * In prod mode, expects the workspace to already have SOUL.md from
 * `openclaw onboard`. Errors if not.
 */
export function ensureAgentIdentity(cfg: Config): {
  configPath: string;
  refreshed: { soulMd: boolean; identityMd: boolean; agentsMd: boolean };
} {
  fs.mkdirSync(cfg.agentWorkspaceDir, { recursive: true });
  fs.mkdirSync(cfg.agentStateDir, { recursive: true });
  fs.mkdirSync(cfg.sessionsArchiveDir, { recursive: true });

  // Always (re)write openclaw.json so config drift gets corrected.
  const configDir = path.join(cfg.agentStateDir, ".openclaw");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  fs.writeFileSync(
    configPath,
    buildOpenclawConfig(cfg.agentWorkspaceDir, cfg.openclawMode),
  );

  const refreshed = { soulMd: false, identityMd: false, agentsMd: false };

  const soulMdPath = path.join(cfg.agentWorkspaceDir, "SOUL.md");
  const identityMdPath = path.join(cfg.agentWorkspaceDir, "IDENTITY.md");
  const agentsMdPath = path.join(cfg.agentWorkspaceDir, "AGENTS.md");

  if (cfg.openclawMode === "test") {
    if (!fs.existsSync(soulMdPath)) {
      fs.writeFileSync(soulMdPath, DEFAULT_SOUL_MD);
      refreshed.soulMd = true;
    }
    if (!fs.existsSync(identityMdPath)) {
      fs.writeFileSync(identityMdPath, DEFAULT_IDENTITY_MD);
      refreshed.identityMd = true;
    }
    // AGENTS.md is operating procedure. Write the default if missing,
    // but never overwrite — users may customize it for their setup.
    // (When Trellis ships new defaults, users diff against ours manually.)
    if (!fs.existsSync(agentsMdPath)) {
      fs.writeFileSync(agentsMdPath, DEFAULT_AGENTS_MD);
      refreshed.agentsMd = true;
    }
  } else {
    if (!fs.existsSync(soulMdPath)) {
      throw new Error(
        `Trellis is in prod mode (TRELLIS_OPENCLAW_MODE=prod) but ` +
          `${soulMdPath} is missing. Run \`openclaw onboard\` against the ` +
          `state dir ${cfg.agentStateDir} first, or switch to test mode ` +
          `(unset TRELLIS_OPENCLAW_MODE) to use Trellis's default identity.`,
      );
    }
  }

  return { configPath, refreshed };
}
