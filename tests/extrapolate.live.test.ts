import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import { extrapolate } from "../src/cycle/extrapolate.js";
import { descendants } from "../src/graph/traversal.js";

const live = process.env.TRELLIS_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;
const describeIfLive = live ? describe : describe.skip;

let db: DB;
let repo: Repo;

describeIfLive("live extrapolation", () => {
  beforeAll(() => {
    db = open({ path: ":memory:" });
    repo = new Repo(db);
  });
  afterAll(() => {
    close(db);
  });

  it(
    "extrapolates a substantive root_purpose into a multi-axis graph",
    async () => {
      const root = repo.createNode({
        type: "root_purpose",
        title: "Build a working prototype of Trellis itself",
        body: "Trellis is the graph-native task substrate. Bootstrap it.",
        status: "open",
        task_kind: "continuous",
        priority: 1,
        schedule: null,
        due_at: null,
        metadata: {},
      });

      const result = await extrapolate(repo, root.id, {
        // smaller budget for tests so we don't burn too much
        maxTokens: 8192,
        thinkingBudget: 4096,
      });

      // Substantive task → many nodes across multiple types.
      expect(result.newNodeIds.length).toBeGreaterThan(15);
      expect(result.newEdgeIds.length).toBeGreaterThan(15);

      const nodes = repo.listNodes();
      const types = new Set(nodes.map((n) => n.type));
      // At minimum, we want subtasks plus at least one of each other axis.
      expect(types.has("task")).toBe(true);
      const hasContingency =
        types.has("risk") || types.has("scenario") || types.has("outcome");
      expect(hasContingency).toBe(true);
      expect(types.has("rationale")).toBe(true);
      // Strategy ladder may stop at the existing root_purpose without creating
      // new strategy nodes, so this is "either strategy nodes exist or the
      // root has incoming ladders_up_to edges".
      const hasStrategyLink =
        types.has("strategy") ||
        repo.edgesTo(root.id, "ladders_up_to").length > 0 ||
        repo.edgesTo(root.id, "subtask_of").length > 0;
      expect(hasStrategyLink).toBe(true);

      // Subtask tree was written.
      expect(descendants(repo, root.id).length).toBeGreaterThan(0);

      // Source was marked in_progress.
      const refreshed = repo.getNode(root.id);
      expect(refreshed?.status).toBe("in_progress");
    },
    180_000,
  );
});
