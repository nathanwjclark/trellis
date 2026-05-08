#!/usr/bin/env node
import { dbInit } from "./commands/db-init.js";
import { ingest } from "./commands/ingest.js";
import { status } from "./commands/status.js";
import { cycle } from "./commands/cycle.js";
import { embedBackfill } from "./commands/embed.js";
import { dedupeSweepCmd } from "./commands/sweep.js";
import { executeCmd } from "./commands/execute.js";
import { loopCmd } from "./commands/loop.js";
import { serveCmd } from "./commands/serve.js";

const HELP = `Usage:
  trellis db:init                              Apply schema migrations.
  trellis ingest --root "<title>" [opts]       Create a root_purpose node.
  trellis ingest --task "<title>" --parent ID  Create a task node under parent.
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

Common options:
  --body "<markdown>"     Long-form body text.
  --priority 0..1         Priority (default 0.5).
  --kind oneoff|recurring|continuous   Task kind (default oneoff for tasks,
                                       continuous for root purposes).

cycle options:
  --phases extrapolate,index,dedupe   Subset of phases to run (default all).
  --max-tokens N          Override extrapolation response ceiling (default 64000).
  --thinking-budget N     Override extended-thinking budget (default 16000).

execute options:
  --leaf <leaf-id>        Override the critical-path-leaf selection.
  --thinking <level>      off | minimal | low | medium | high (default medium).
  --timeout <seconds>     Subprocess timeout (default 600).

loop options:
  --root <node-id>        Restrict scheduling to descendants of this node.
                          Default: highest-priority open root_purpose.
  --iterations N          Stop after N iterations.
  --max-time <duration>   Stop after this wall-clock duration (e.g. 5m, 1h).
  --max-cost <USD>        Stop when estimated spend on this loop exceeds USD.

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
