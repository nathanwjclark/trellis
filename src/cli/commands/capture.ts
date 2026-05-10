import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { loadConfig } from "../config.js";

/**
 * `trellis capture` — chat-aware shortcut for adding a task to the graph.
 *
 * Designed to be invoked from inside a chat session by the agent (Cass)
 * when a conversation surfaces a task or work item that should land in
 * Trellis. The defaults assume that context: priority bumped above the
 * generic 0.5 (a chat usually means "this is alive right now"), parent
 * defaults to the active root_purpose, and provenance metadata records
 * the chat session id so we can trace the task back to its origin.
 */
export async function capture(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  const title = typeof flags.title === "string" ? flags.title : null;
  if (!title) {
    db.close();
    throw new Error('capture requires --title "<title>"');
  }

  const body = typeof flags.body === "string" ? flags.body : "";
  const source = typeof flags.source === "string" ? flags.source : "chat";
  const sessionId =
    typeof flags["session-id"] === "string" ? flags["session-id"] : null;
  const priority =
    typeof flags.priority === "string" ? Number.parseFloat(flags.priority) : 0.7;

  let parentId: string | null = null;
  if (typeof flags.parent === "string") {
    const parent = repo.getNode(flags.parent);
    if (!parent) {
      db.close();
      throw new Error(`parent node ${flags.parent} not found`);
    }
    parentId = parent.id;
  } else {
    const roots = repo.listNodes({ type: "root_purpose", status: "open" });
    if (roots.length === 0) {
      db.close();
      throw new Error(
        "no open root_purpose found. Pass --parent <node-id> or ingest a root first.",
      );
    }
    if (roots.length > 1) {
      const titles = roots.map((r) => `${r.id} ${r.title}`).join("\n  ");
      db.close();
      throw new Error(
        `multiple open root_purposes — pass --parent <node-id> to disambiguate:\n  ${titles}`,
      );
    }
    parentId = roots[0]!.id;
  }

  const node = repo.createNode({
    type: "task",
    title,
    body,
    status: "open",
    task_kind: "oneoff",
    priority,
    schedule: null,
    due_at: null,
    metadata: {
      captured_at: Date.now(),
      source,
      ...(sessionId ? { session_id: sessionId } : {}),
    },
  });

  repo.addEdge({
    from_id: node.id,
    to_id: parentId,
    type: "subtask_of",
    weight: 1,
    metadata: { captured: true },
  });

  process.stdout.write(`${node.id}\t${node.title}\n`);
  db.close();
}
