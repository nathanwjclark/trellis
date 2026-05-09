# Trellis

Graph-native task substrate for autonomous agents.

Trellis turns an agent's task list into a living graph. Every task, subtask,
note, memory, concept, person, scenario, risk, rationale, and strategy is a
node. When the agent picks up a task, it runs a multi-phase cycle —
**extrapolate → index → deduplicate** — that grows the graph along the four
axes a strategist would intuitively explore: subtasks (down), contingencies
(forward), rationale (back), strategy ladder (up). A separate **execute**
phase hands an atomic leaf to OpenClaw and writes the result back to the
graph.

The graph is the agent's persistent mind. OpenClaw is the work engine that
takes a leaf plus its relevant subgraph context and executes it.

Trellis is a sibling to `openclaw/` — it does **not** modify openclaw and
invokes it as a subprocess.

## Status

- **v0.1 shipped**: graph storage, full three-phase cycle, graph-wide dedupe
  sweep with transitive merge resolution.
- **v0.2 shipped**: OpenClaw executor — leaves run as real agent sessions
  with structured `result.json` writeback and graph mutations.
- **v0.3 next**: continuous daemon loop + monitoring UI.

## Setup

### Required

- **Node 22.16+** (or 24 — matches OpenClaw's runtime floor).
- **pnpm** (corepack will install it on first invocation).
- **Anthropic API key** for cycle phases (extrapolate/index/dedupe).

### Required for `execute` only

- **OpenClaw checkout** somewhere on disk (`git clone https://github.com/openclaw/openclaw`).
  Trellis invokes its `openclaw.mjs` entry — your checkout doesn't need to be
  installed globally. Anthropic key from the same env is used by openclaw.
- That's it. `openclaw agent --local` runs embedded; no daemon, no auth setup.

### Optional

- **Voyage AI API key** if you want cloud embeddings (`voyage-3.5` etc.).
  Default is local `Xenova/all-MiniLM-L6-v2` via transformers.js — no key
  needed, ~25MB model auto-downloaded into `data/models/` on first use.

### Environment

```bash
pnpm install
cp .env.example .env
# At minimum, fill ANTHROPIC_API_KEY.
# For execute, also set OPENCLAW_PATH=/path/to/openclaw
```

## Quick start

```bash
# Initialize the graph database
pnpm trellis db:init

# Ingest a root purpose
pnpm trellis ingest --root "Make a working prototype of Trellis"

# Run the three-phase cycle (graph-management only — does NOT execute)
pnpm trellis cycle --node <root-id>

# Inspect the graph
pnpm trellis status
pnpm trellis status --tree <root-id>

# Optional: graph-wide dedupe sweep
pnpm trellis dedupe-sweep
```

## Two cycle modes

**`trellis cycle`** runs *graph management only*: extrapolate → index → dedupe.
No execution. Use this when you want to inspect or refine the graph structure
without spending tokens on agent work — particularly useful for testing the
substrate or browsing in the UI (when v0.3 lands).

**`trellis execute`** picks the critical-path leaf under a node and hands it
to an OpenClaw subprocess. The agent reads workspace bootstrap files
(`AGENTS.md`, `WORK_CONTEXT.md`, `RESULT_SCHEMA.md`), does the work, writes
`result.json`, and Trellis applies the result back to the graph (status
transitions, new note nodes, new subtasks for `needs_decomposition`).

```bash
pnpm trellis execute --node <task-id>            # auto-descends to leaf
pnpm trellis execute --node <X> --leaf <leaf-id> # override leaf selection
pnpm trellis execute --node <X> --thinking high  # off|minimal|low|medium|high
```

## Where things live

```
data/trellis.db                   — the graph (SQLite, gitignored)
data/sessions/<session-id>/       — per-execution workspace (the agent's sandbox)
  ├── AGENTS.md                    (Trellis-worker persona for the agent)
  ├── WORK_CONTEXT.md              (leaf body + ancestors + siblings + risks)
  ├── RESULT_SCHEMA.md             (the JSON shape the agent must produce)
  ├── result.json                  (the agent's structured verdict)
  ├── envelope.json                (parsed openclaw --json envelope)
  ├── openclaw.stdout.log
  ├── openclaw.stderr.log          (stream from the subprocess)
  └── (any code/artifacts the agent produced during the leaf)
data/openclaw-state/<session-id>/ — isolated OpenClaw state (gitignored)
data/sandboxes/                   — promoted/preserved agent work products,
                                    kept out of the project tree until a human
                                    reviews and copies anything worth keeping
                                    into the real source.
data/logs/                        — per-call ndjson logs from cycle phases
data/models/                      — local embedding model cache
```

## Sandbox convention

Every `trellis execute` call runs the agent in an isolated workspace under
`data/sessions/<session-id>/` (gitignored). The agent's `AGENTS.md` is
explicit: **all writes happen inside this workspace, period**. Reading
external files is fine; modifying them is not. If a leaf seems to require
editing source under the project root, the agent makes a copy in the
workspace, edits the copy, and lists the proposed changes in
`result.json.artifacts`. A human (or a future `trellis promote` command)
decides whether to copy those changes into the real tree on a feature
branch.

This keeps agent experimentation safe, makes review tractable, and
prevents agent-produced files from blending into the real source. The
boundary is enforced by prompt convention (not OS sandboxing) — fine for
local use; revisit if production-deploying.

## Layout

```
src/graph/      — schema, SQLite layer, repo, embeddings, traversal
src/cycle/      — extrapolate, index, deduplicate, sweep, orchestrate
src/task/       — execute (leaf → openclaw → graph writeback)
src/openclaw/   — subprocess adapter, workspace bootstrap, result types
src/llm/        — Anthropic client, Voyage client, local transformers, models, log
src/prompts/    — extrapolate / index_prompt / dedupe_prompt
src/cli/        — entry point + per-command modules
tests/          — Vitest unit + gated live integration tests
```

## Configuration

All overridable via env (see `.env.example`):

| var | default | purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required; cycle + execute |
| `OPENCLAW_PATH` | — | required for execute; absolute path to openclaw checkout |
| `VOYAGE_API_KEY` | — | optional; only used if embedding model starts with `voyage-` |
| `TRELLIS_DB_PATH` | `./data/trellis.db` | graph DB location |
| `TRELLIS_SESSIONS_DIR` | `./data/sessions` | per-execution workspaces |
| `TRELLIS_OPENCLAW_STATE_DIR` | `./data/openclaw-state` | isolated openclaw state per session |
| `TRELLIS_LOG_DIR` | `./data/logs` | cycle ndjson logs |
| `TRELLIS_LOCAL_MODELS_DIR` | `./data/models` | transformers.js model cache |
| `TRELLIS_MODEL_REASONING` | `claude-sonnet-4-6` | extrapolation + dedupe-decision |
| `TRELLIS_MODEL_HAIKU` | `claude-haiku-4-5` | index + dedupe |
| `TRELLIS_MODEL_EMBEDDING` | `Xenova/all-MiniLM-L6-v2` | embeddings (Voyage models route to API) |
| `TRELLIS_AGENT_IDENTITY` | `trellis-default` | namespaces the persistent workspace + state |
| `TRELLIS_OPENCLAW_MODE` | `test` | `test` = Trellis owns the openclaw setup; `prod` = client of user's openclaw |
| `TRELLIS_AGENT_WORKSPACE` | `data/agents/<identity>/workspace` | override to point at user's existing openclaw workspace (prod mode) |
| `TRELLIS_AGENT_STATE_DIR` | `data/agents/<identity>/state` | override to point at user's existing openclaw state dir (prod mode) |

## Prod-mode setup

By default Trellis runs in **test mode**: it owns the openclaw workspace and state dir under `data/agents/<identity>/`, pre-fills `SOUL.md`/`IDENTITY.md`/`AGENTS.md` as a default agent identity, and writes `openclaw.json` with the memory + skill plugins enabled. Fast to iterate on; nothing to set up.

For long-term use against a real persistent openclaw — your normal openclaw with your own identity, memory, skills, plugins — switch to **prod mode**:

```bash
# 1. Make sure your openclaw is onboarded.
openclaw onboard
# This creates SOUL.md / IDENTITY.md / AGENTS.md plus openclaw.json
# in your normal state dir (typically ~/.openclaw or whatever
# OPENCLAW_STATE_DIR is set to).

# 2. Tell Trellis where your openclaw lives.
export TRELLIS_OPENCLAW_MODE=prod
export TRELLIS_AGENT_WORKSPACE=/path/to/your/openclaw/workspace
export TRELLIS_AGENT_STATE_DIR=/path/to/your/.openclaw

# 3. Run Trellis as normal.
pnpm trellis loop --iterations 5
```

In prod mode Trellis:
- Doesn't touch your `openclaw.json` (you control plugins, models, etc.)
- Doesn't pre-fill identity files (errors if `SOUL.md` is missing in the workspace)
- Writes its transient leaf brief files (`CURRENT_LEAF.md`, `WORK_CONTEXT.md`, `RESULT_SCHEMA.md`, `TRELLIS_OPS.md`, `progress.json`, `result.json`) into `<workspace>/.trellis/` — gitignore that subdir on your end if you check the workspace into version control
- Uses session id `trellis-<identity>` (default `trellis-trellis-default`) so its conversation thread is namespaced apart from your other openclaw sessions

You can run multiple Trellis identities against one openclaw setup by varying `TRELLIS_AGENT_IDENTITY` — each gets its own openclaw session id and its own per-identity sessions archive.

## Tests

```bash
pnpm test            # unit tests only (fast, no API calls)
pnpm test:live       # gated live integration tests (requires API keys)
```

## License

MIT.
