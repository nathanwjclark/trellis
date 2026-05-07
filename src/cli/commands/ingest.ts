import { open } from "../../graph/db.js";
import { Repo } from "../../graph/repo.js";
import { TaskKind } from "../../graph/schema.js";
import { loadConfig } from "../config.js";

export async function ingest(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const cfg = loadConfig();
  const db = open({ path: cfg.dbPath });
  const repo = new Repo(db);

  const isRoot = flags.root !== undefined;
  const isTask = flags.task !== undefined;
  if (!isRoot && !isTask) {
    throw new Error("ingest requires --root \"<title>\" or --task \"<title>\"");
  }

  const title = String(isRoot ? flags.root : flags.task);
  if (!title || title === "true") {
    throw new Error("title is required after --root or --task");
  }

  const body = typeof flags.body === "string" ? flags.body : "";
  const priority =
    typeof flags.priority === "string"
      ? Number.parseFloat(flags.priority)
      : isRoot
        ? 1
        : 0.5;

  const kindFlag = typeof flags.kind === "string" ? flags.kind : null;
  const taskKind = kindFlag
    ? TaskKind.parse(kindFlag)
    : isRoot
      ? "continuous"
      : "oneoff";

  const node = repo.createNode({
    type: isRoot ? "root_purpose" : "task",
    title,
    body,
    status: "open",
    task_kind: taskKind,
    priority,
    schedule: null,
    due_at: null,
    metadata: {},
  });

  if (isTask && typeof flags.parent === "string") {
    const parent = repo.getNode(flags.parent);
    if (!parent) throw new Error(`parent node ${flags.parent} not found`);
    repo.addEdge({
      from_id: node.id,
      to_id: parent.id,
      type: "subtask_of",
      weight: 1,
      metadata: {},
    });
  }

  process.stdout.write(`${node.type}\t${node.id}\t${node.title}\n`);
  db.close();
}
