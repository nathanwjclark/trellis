import fs from "node:fs";
import path from "node:path";

/**
 * Read the agent's identity memory and recent daily notes from its
 * openclaw workspace. The deeper extrapolator is given these so its
 * outputs are colored by the agent's accumulated voice and context,
 * not just the graph and the prompt. Mirrors what the openclaw memory
 * plugin would inject during a normal agent session.
 *
 * Files we look for (matches openclaw's defaults):
 *   <workspace>/MEMORY.md          — the curated long-term memory
 *   <workspace>/SOUL.md            — agent voice / persona
 *   <workspace>/IDENTITY.md        — short id card
 *   <workspace>/memory/YYYY-MM-DD.md — daily journal entries
 *
 * Each file is read up to a per-file byte cap so a runaway journal
 * can't blow the prompt budget; we surface the truncation explicitly.
 */
export interface AgentMemoryBundle {
  /** Concatenated markdown the prompt can drop in directly. Empty
   *  string if the workspace doesn't exist or has no recognizable
   *  identity files. */
  text: string;
  /** Files we successfully read, in the order they appear in `text`. */
  files: { path: string; bytes: number; truncated: boolean }[];
  /** Files we looked for but couldn't read. Useful for debugging an
   *  unexpectedly-empty bundle. */
  missing: string[];
}

const MAX_FILE_BYTES = 50 * 1024;
const MAX_DAILY_FILES = 7;

export function readAgentMemory(workspaceDir: string): AgentMemoryBundle {
  const files: AgentMemoryBundle["files"] = [];
  const missing: string[] = [];
  const sections: string[] = [];

  // Identity-shaped files at the workspace root.
  for (const name of ["IDENTITY.md", "SOUL.md", "MEMORY.md"]) {
    const abs = path.join(workspaceDir, name);
    const r = readCapped(abs, MAX_FILE_BYTES);
    if (r === null) {
      missing.push(name);
      continue;
    }
    files.push({ path: name, bytes: r.bytes, truncated: r.truncated });
    sections.push(`### ${name}\n\n${r.text.trim()}`);
  }

  // Recent daily journal entries from `memory/YYYY-MM-DD.md`.
  const dailyDir = path.join(workspaceDir, "memory");
  let dailyEntries: string[] = [];
  try {
    dailyEntries = fs
      .readdirSync(dailyDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse()
      .slice(0, MAX_DAILY_FILES);
  } catch {
    /* dailyDir may not exist; that's fine */
  }
  if (dailyEntries.length > 0) {
    const dailySections: string[] = [];
    for (const name of dailyEntries.reverse()) {
      const abs = path.join(dailyDir, name);
      const r = readCapped(abs, MAX_FILE_BYTES);
      if (r === null) continue;
      files.push({
        path: `memory/${name}`,
        bytes: r.bytes,
        truncated: r.truncated,
      });
      dailySections.push(`#### memory/${name}\n\n${r.text.trim()}`);
    }
    if (dailySections.length > 0) {
      sections.push(
        `### Recent daily journal (last ${dailySections.length} entries)\n\n${dailySections.join("\n\n")}`,
      );
    }
  }

  const text = sections.length === 0 ? "" : sections.join("\n\n");
  return { text, files, missing };
}

function readCapped(
  p: string,
  cap: number,
): { text: string; bytes: number; truncated: boolean } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= cap) return { text: raw, bytes, truncated: false };
  // Truncate at a UTF-8 boundary, prefer end-of-line.
  let cut = raw.slice(0, cap);
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > cap - 4 * 1024) cut = cut.slice(0, lastNl);
  return {
    text: cut + "\n\n[…truncated; original was " + bytes + " bytes]",
    bytes,
    truncated: true,
  };
}
