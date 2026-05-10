#!/usr/bin/env node
import { dbInit } from "./commands/db-init.js";
import { ingest } from "./commands/ingest.js";
import { capture } from "./commands/capture.js";
import { introspect } from "./commands/introspect.js";
import { review } from "./commands/review.js";
import { status } from "./commands/status.js";
import { cycle } from "./commands/cycle.js";
import { embedBackfill } from "./commands/embed.js";
import { dedupeSweepCmd } from "./commands/sweep.js";
import { executeCmd } from "./commands/execute.js";
import { loopCmd } from "./commands/loop.js";
import { serveCmd } from "./commands/serve.js";
import { snapshotCmd } from "./commands/snapshot.js";
import { resetCmd } from "./commands/reset.js";

const HELP = `Usage:
  trellis db:init                              Apply schema migrations.
  trellis ingest --root "<title>" [opts]       Create a root_purpose node.
  trellis ingest --task "<title>" --parent ID  Create a task node under parent.
  trellis capture --title "<title>" [opts]     Add a chat-derived task to the
                                               graph. Defaults parent to the
                                               sole open root_purpose; bumps
                                               priority above generic 0.5;
                                               records source/session_id in
                                               metadata for provenance.
  trellis cycle --node <node-id>               Graph-management only: extrapolate
                                               → index → dedupe. Does NOT execute.
                                               Use this for testing the substrate.
  trellis execute --node <node-id>             Hand a leaf to OpenClaw and apply
                                               the agent's result back to the graph.
                                               Auto-descends to critical-path leaf.
  trellis loop [opts]                          Continuous daemon: pick → cycle-if-
                                               needed → execute → repeat. ctrl+c to
                                               stop. See loop options below.
  trellis serve [--port N]                     Start the monitoring HTTP API at
                                               http://127.0.0.1:18810 (default).
                                               UI dev server proxies /api here.
  trellis embed-backfill                       Embed any node missing/stale under
                                               the configured embedding model.
  trellis dedupe-sweep                         Graph-wide dedupe pass. Backfills
                                               embeddings, finds near-duplicates,
                                               applies merges transitively.
  trellis status [--tree <node-id>] [--json]   Show graph summary or subtree.
                                               --json emits machine-readable JSON.
  trellis snapshot --save|--restore|--list     Save / restore / list / delete
                  --delete <name>              graph DB snapshots under
                                               data/snapshots/.
  trellis reset --extrapolations --yes         Wipe non-root_purpose nodes
                                               (cascades edges, embeddings).
  trellis introspect [--since 6h] [--json]     Six-stat report on the run's
                                               temperature: revision pattern,
                                               axis balance, knowledge-capital
                                               fraction, re-extrapolation,
                                               lateral movement, scheduler
                                               rationale classification.
  trellis review --human-blocked [--no-apply]  One-shot graph-wide pass that
                                               flags open tasks requiring
                                               human action with status=
                                               human_blocked. --no-apply for
                                               dry-run.

Common options:
  --body "<markdown>"     Long-form body text.
  --priority 0..1         Priority (default 0.5).
  --kind oneoff|recurring|continuous   Task kind (default oneoff for tasks,
                                       continuous for root purposes).

capture options:
  --title "<title>"       Required. Short label for the new task.
  --body "<markdown>"     Optional long-form context (the chat snippet,
                          relevant excerpts, etc).
  --parent <node-id>      Required only when multiple open root_purposes
                          exist; otherwise defaults to the sole one.
  --source <label>        Provenance tag (default "chat").
  --session-id <opaque>   Chat session id, recorded in metadata.

cycle options:
  --phases extrapolate,index,dedupe   Subset of phases to run (default all).
  --max-tokens N          Override extrapolation response ceiling (default 64000).
  --thinking-budget N     Override extended-thinking budget (default 16000).

execute options:
  --leaf <leaf-id>        Override the critical-path-leaf selection.
  --thinking <level>      off | minimal | low | medium | high (default medium).
  --timeout <seconds>     Hard subprocess timeout (default 1800 = 30 min).
                          The agent doesn't see this; it follows a
                          checkpoint pattern (progress.json) so partial
                          work survives if the timer fires.

loop options:
  --scheduler agent|critical-path   Decision algorithm. Default: agent (Sonnet
                                    picks each iteration, sees the whole graph,
                                    can rotate across subtrees). critical-path
                                    is the deterministic fallback.
  --root <node-id>        Restrict scheduling to descendants of this node.
                          Default: highest-priority open root_purpose.
  --iterations N          Stop after N iterations.
  --max-time <duration>   Stop after this wall-clock duration (e.g. 5m, 1h).
  --max-cost <USD>        Stop when estimated spend on this loop exceeds USD.

snapshot options:
  --save <name>           Snapshot the graph DB to data/snapshots/<name>.db.
  --restore <name>        Restore from data/snapshots/<name>.db (needs --yes).
  --list                  List available snapshots.
  --delete <name>         Delete a snapshot.
  --force                 Overwrite existing snapshot (--save) or override
                          the busy-WAL safety check (--restore).
  --yes                   Confirm destructive --restore.

reset options:
  --extrapolations        Delete every non-root_purpose node (cascades).
  --yes                   Required to actually run.

embed-backfill options:
  --model <id>            Embedding model id. Defaults to TRELLIS_MODEL_EMBEDDING
                          or the built-in (Xenova/all-MiniLM-L6-v2).

dedupe-sweep options:
  --k N                   Top-K neighbors per node. Default 4.
  --min-similarity F      Cosine similarity floor (0..1). Default 0.78.
  --chunk-size N          Candidate blocks per Haiku call. Default 25.
  --skip-backfill         Skip embedding backfill (fail if any node lacks one).
`;

function parseArgs(argv: string[]): {
  cmd: string;
  flags: Record<string, string | boolean>;
} {
  const cmd = argv[0] ?? "help";
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { cmd, flags };
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "db:init":
      await dbInit();
      break;
    case "ingest":
      await ingest(flags);
      break;
    case "capture":
      await capture(flags);
      break;
    case "introspect":
      await introspect(flags);
      break;
    case "review":
      await review(flags);
      break;
    case "status":
      await status(flags);
      break;
    case "cycle":
      await cycle(flags);
      break;
    case "execute":
      await executeCmd(flags);
      break;
    case "loop":
      await loopCmd(flags);
      break;
    case "serve":
      await serveCmd(flags);
      break;
    case "snapshot":
      await snapshotCmd(flags);
      break;
    case "reset":
      await resetCmd(flags);
      break;
    case "embed-backfill":
      await embedBackfill(flags);
      break;
    case "dedupe-sweep":
      await dedupeSweepCmd(flags);
      break;
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
