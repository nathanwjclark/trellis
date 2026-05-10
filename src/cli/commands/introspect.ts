import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import {
  computeIntrospection,
  type IntrospectionReport,
} from "../../introspect/compute.js";
import { loadConfig } from "../config.js";

/**
 * `trellis introspect` — six-stat report on graph + scheduler behavior.
 *
 * Designed to expose "temperature collapse": the pattern where a run
 * front-loads extrapolation, then settles into pure execute-the-next-
 * critical-path-leaf with no revisiting, no cross-subtree movement,
 * and no scheduler rationale that mentions reconsidering anything.
 */
export async function introspect(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  const sinceMs = parseSince(flags.since);
  const report = computeIntrospection({
    repo,
    logsDir: cfg.logsDir,
    sinceMs,
  });

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report) + "\n");
  }
  db.close();
}

function parseSince(v: string | boolean | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.match(/^(\d+)\s*([smhd])$/);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2];
  const ms =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return Date.now() - n * ms;
}

export function formatReport(r: IntrospectionReport): string {
  const lines: string[] = [];
  const gs = r.graph_summary;
  lines.push(`TRELLIS INTROSPECTION  ·  ${new Date(r.generated_at).toISOString()}`);
  lines.push("");
  lines.push(
    `graph: ${gs.total_nodes} nodes, ${gs.total_edges} edges`,
  );
  lines.push(
    `status: ${formatRecord(gs.by_status)}`,
  );
  if (gs.spans_ms.earliest && gs.spans_ms.latest) {
    const hrs = Math.round(
      ((gs.spans_ms.latest - gs.spans_ms.earliest) / 3_600_000) * 10,
    ) / 10;
    lines.push(`spans: ${hrs}h of activity`);
  }
  lines.push("");

  // 1
  const gv = r.generative_vs_revision;
  lines.push("─── 1. GENERATIVE vs REVISION ───────────────────────────");
  lines.push(
    `  ${gv.total_creations} creations · ${gv.total_updates} updates  →  ${gv.updates_per_node} updates/node`,
  );
  lines.push("  revision histogram (how many times each node was touched):");
  const hist = gv.revision_histogram;
  for (const k of ["1", "2", "3", "4+"]) {
    const v = hist[k] ?? 0;
    const pct =
      gs.total_nodes > 0
        ? `(${Math.round((v / gs.total_nodes) * 100)}%)`
        : "";
    const bar = "█".repeat(Math.min(40, Math.round((v / Math.max(1, gs.total_nodes)) * 40)));
    lines.push(`    rev=${k.padEnd(3)} ${String(v).padStart(5)} ${pct.padEnd(6)} ${bar}`);
  }
  if (gv.time_buckets.length > 0) {
    lines.push("  time buckets (created / updated):");
    for (const b of gv.time_buckets) {
      const ts = new Date(b.start).toISOString().slice(11, 16);
      const c = "+".repeat(Math.min(30, b.created));
      const u = "·".repeat(Math.min(30, b.updated));
      lines.push(
        `    ${ts}  ${String(b.created).padStart(4)}/${String(b.updated).padEnd(4)} ${c}${u}`,
      );
    }
  }
  lines.push("");

  // 2
  lines.push("─── 2. PER-AXIS EXTRAPOLATION BALANCE ───────────────────");
  for (const k of ["down", "forward", "back", "up", "lateral", "other"] as const) {
    const a = r.axis_balance.axes[k];
    const pct = Math.round(a.fraction * 1000) / 10;
    const bar = "█".repeat(Math.round(pct / 2));
    const types = Object.entries(a.edge_types)
      .map(([t, n]) => `${t}=${n}`)
      .join(", ");
    lines.push(
      `  ${k.padEnd(8)} ${String(a.count).padStart(5)} (${String(pct).padStart(4)}%) ${bar}`,
    );
    if (types) lines.push(`           ${types}`);
  }
  lines.push("");

  // 3
  const kc = r.knowledge_capital;
  lines.push("─── 3. KNOWLEDGE CAPITAL ────────────────────────────────");
  lines.push(
    `  thinking nodes: ${kc.thinking_count} (${Math.round(kc.thinking_fraction * 100)}%)`,
  );
  lines.push(`  doing nodes:    ${kc.doing_count}`);
  lines.push(`  by type:`);
  for (const [t, n] of Object.entries(kc.by_type).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${t.padEnd(13)} ${String(n).padStart(5)}`);
  }
  const rf = kc.research_followthrough;
  if (rf.total > 0) {
    lines.push(
      `  research follow-through: ${rf.answered}/${rf.total} answered (${rf.unanswered} unanswered)`,
    );
  } else {
    lines.push(`  research follow-through: 0 research nodes ever created`);
  }
  lines.push("");

  // 4
  const re = r.re_extrapolation;
  lines.push("─── 4. RE-EXTRAPOLATION ─────────────────────────────────");
  lines.push(`  total extrapolate calls: ${re.total_extrapolate_calls}`);
  lines.push(
    `  on previously-cycled nodes: ${re.on_previously_cycled_nodes}`,
  );
  lines.push(
    `  on parent after descendant executed: ${re.on_parent_after_descendant_executed}`,
  );
  if (re.examples.length > 0) {
    lines.push(`  most-revisited:`);
    for (const ex of re.examples) {
      lines.push(`    ${ex.source_id.slice(0, 8)}  cycled ${ex.count}×`);
    }
  }
  lines.push("");

  // 5
  const lm = r.lateral_movement;
  lines.push("─── 5. LATERAL MOVEMENT ─────────────────────────────────");
  lines.push(`  scheduler picks: ${lm.scheduler_picks}`);
  lines.push(
    `  median distance from prev pick: ${lm.median_distance}  ·  mean: ${lm.mean_distance}`,
  );
  lines.push(`  distance histogram:`);
  for (const k of ["1", "2", "3", "4", "5+", "disconnected"]) {
    const v = lm.distance_histogram[k] ?? 0;
    const total = Math.max(1, lm.scheduler_picks - 1);
    const pct = Math.round((v / total) * 100);
    const bar = "█".repeat(Math.round(pct / 2));
    lines.push(`    d=${k.padEnd(13)} ${String(v).padStart(5)} (${String(pct).padStart(3)}%) ${bar}`);
  }
  lines.push("");

  // 6
  const sr = r.scheduler_rationales;
  lines.push("─── 6. SCHEDULER RATIONALES ─────────────────────────────");
  lines.push(`  total decisions: ${sr.total_decisions}`);
  const total = Math.max(1, sr.total_decisions);
  for (const k of ["exploit", "explore", "neutral"] as const) {
    const v = sr.classified[k];
    const pct = Math.round((v / total) * 100);
    lines.push(
      `  ${k.padEnd(8)} ${String(v).padStart(5)} (${String(pct).padStart(3)}%)`,
    );
  }
  for (const k of ["explore", "exploit", "neutral"] as const) {
    if (sr.examples[k].length === 0) continue;
    lines.push(`  example "${k}" rationales:`);
    for (const ex of sr.examples[k]) {
      lines.push(`    · ${truncate(ex, 140)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatRecord(r: Record<string, number>): string {
  return Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
