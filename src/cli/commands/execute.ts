import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { execute } from "../../task/execute.js";
import { loadConfig } from "../config.js";

export async function executeCmd(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const nodeId = typeof flags["node"] === "string" ? flags["node"] : null;
  if (!nodeId) {
    throw new Error(
      "execute requires --node <node-id>. Use the source task; the executor descends to the critical-path leaf automatically.",
    );
  }

  const thinkingFlag =
    typeof flags["thinking"] === "string"
      ? (flags["thinking"] as "off" | "minimal" | "low" | "medium" | "high")
      : undefined;
  const timeoutSeconds =
    typeof flags["timeout"] === "string"
      ? Number.parseInt(flags["timeout"], 10)
      : undefined;
  const leafIdOverride =
    typeof flags["leaf"] === "string" ? flags["leaf"] : undefined;

  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  process.stdout.write(`executing under: ${nodeId}\n`);
  if (leafIdOverride) {
    process.stdout.write(`(leaf override: ${leafIdOverride})\n`);
  }
  process.stdout.write(`agent identity: ${cfg.agentIdentity} (${cfg.openclawMode} mode)\n`);
  process.stdout.write(`agent workspace: ${cfg.agentWorkspaceDir}\n`);
  process.stdout.write(`session archive: ${cfg.sessionsArchiveDir}\n`);
  process.stdout.write(`(this can take several minutes — openclaw runs the agent)\n\n`);

  const result = await execute(repo, cfg, nodeId, {
    leafIdOverride,
    thinking: thinkingFlag,
    timeoutSeconds,
  });

  process.stdout.write(`✓ execution complete\n`);
  process.stdout.write(`  session id:    ${result.sessionId}\n`);
  process.stdout.write(`  duration:      ${(result.durationMs / 1000).toFixed(1)}s\n`);
  process.stdout.write(`  leaf:          ${result.leaf.id} — ${result.leaf.title}\n`);
  process.stdout.write(`  selected via:  ${result.selected}\n`);
  process.stdout.write(`  workspace:     ${result.workspaceDir}\n`);
  process.stdout.write(`  openclaw exit: ${result.adapter.exitCode}\n`);
  process.stdout.write(`  result.json:   ${result.adapter.resultJsonPath ?? "(missing)"}\n`);
  if (result.adapter.resultIssues.length > 0) {
    process.stdout.write(`  issues:\n`);
    for (const i of result.adapter.resultIssues) {
      process.stdout.write(`    - ${i}\n`);
    }
  }
  process.stdout.write(`\ngraph deltas:\n`);
  process.stdout.write(`  applied status: ${result.appliedStatus ?? "(none)"}\n`);
  process.stdout.write(`  new notes:      ${result.newNoteIds.length}\n`);
  process.stdout.write(`  new tasks:      ${result.newTaskIds.length}\n`);
  if (result.adapter.result) {
    process.stdout.write(`\nagent summary:\n  ${result.adapter.result.summary.replace(/\n/g, "\n  ")}\n`);
  }
  process.stdout.write(`\nlogs:\n`);
  process.stdout.write(`  trellis:        ${result.logPath}\n`);
  process.stdout.write(`  openclaw out:   ${result.adapter.stdoutPath}\n`);
  process.stdout.write(`  openclaw err:   ${result.adapter.stderrPath}\n`);

  db.close();
}
