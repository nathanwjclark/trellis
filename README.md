# Trellis

Graph-native task architecture for OpenClaw agents.

Trellis turns an agent's task list into a living graph. Every task, subtask, note,
memory, concept, person, scenario, risk, rationale, and strategy is a node. When
the agent picks up a task, it runs a four-phase cycle —
**extrapolate → index → deduplicate → execute** — that grows the graph along the
four axes a strategy consultant would intuitively explore: subtasks (down),
contingencies (forward), rationale (back), strategy ladder (up). A nightly
**dream cycle** does deeper graph-wide pruning, relationship synthesis, and
memory consolidation.

The graph is the agent's persistent mind. OpenClaw is the work engine that takes
a leaf task plus its relevant subgraph context and executes it.

This project is a sibling to `openclaw/` — it does **not** modify openclaw and
invokes it as a subprocess (same pattern as `vending-bench` and `vox_moduli`).

## Status

v0.1 in progress. Foundation: graph schema, SQLite + sqlite-vec backend, repo,
CLI ingest. The cycle phases (LLM-driven extrapolate / index / deduplicate) and
the OpenClaw executor land in subsequent slices — see
`/Users/nathanclark/.claude/plans/squishy-strolling-trinket.md` for the full
plan.

## Quick start (foundation only)

```bash
pnpm install
cp .env.example .env  # fill ANTHROPIC_API_KEY at minimum (used in v0.1 cycle phase)
pnpm trellis db:init
pnpm trellis ingest --root "Build a working prototype of Trellis itself"
pnpm trellis status
```

## Layout

```
src/graph/      — schema, SQLite layer, repo, embeddings, traversal
src/cycle/      — extrapolate, index, deduplicate, orchestrate
src/task/       — selection, execution, ingestion, context assembly
src/openclaw/   — subprocess adapter (workspace bootstrap, JSON envelope)
src/dream/      — nightly cycle stages
src/server/     — Hono REST + SSE for the monitoring UI
src/scheduler/  — daemon main loop and budget guards
src/llm/        — Anthropic + OpenAI clients
src/cli/        — entry point and commands
ui/             — Vite + React monitoring UI (lands in v0.3)
tests/          — Vitest unit + live integration tests
```

## Design

See `/Users/nathanclark/.claude/plans/squishy-strolling-trinket.md`.
