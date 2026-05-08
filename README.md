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
data/sessions/<session-id>/       — per-execution workspace
  ├── AGENTS.md                    (Trellis-worker persona for the agent)
  ├── WORK_CONTEXT.md              (leaf body + ancestors + siblings + risks)
  ├── RESULT_SCHEMA.md             (the JSON shape the agent must produce)
  ├── result.json                  (the agent's structured verdict)
  ├── envelope.json                (parsed openclaw --json envelope)
  ├── openclaw.stdout.log
  └── openclaw.stderr.log          (stream from the subprocess)
data/openclaw-state/<session-id>/ — isolated OpenClaw state (gitignored)
data/logs/                        — per-call ndjson logs from cycle phases
data/models/                      — local embedding model cache
```

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

## Tests

```bash
pnpm test            # unit tests only (fast, no API calls)
pnpm test:live       # gated live integration tests (requires API keys)
```

## License

MIT.
