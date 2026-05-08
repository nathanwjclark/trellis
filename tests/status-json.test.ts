import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { open, close } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import { gatherSummary, gatherTree } from "../src/cli/commands/status.js";

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = open({ path: ":memory:" });
  repo = new Repo(db);
});

afterEach(() => {
  close(db);
});

describe("status --json data gathering", () => {
  it("gatherSummary returns type counts, roots, and events", () => {
    const root = repo.createNode({
      type: "root_purpose",
      title: "Ship Trellis",
      body: "build it",
      status: "open",
      task_kind: "continuous",
      priority: 1,
      schedule: null,
      due_at: null,
      metadata: {},
    });

    repo.createNode({
      type: "task",
      title: "Write tests",
      body: "unit tests",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });

    const data = gatherSummary(repo);

    // type counts
    expect(data.type_counts["root_purpose"]).toBe(1);
    expect(data.type_counts["task"]).toBe(1);

    // root purposes
    expect(data.root_purposes).toHaveLength(1);
    expect(data.root_purposes[0].id).toBe(root.id);
    expect(data.root_purposes[0].title).toBe("Ship Trellis");
    expect(data.root_purposes[0].status).toBe("open");

    // recent events (node creation emits events)
    expect(Array.isArray(data.recent_events)).toBe(true);
    for (const ev of data.recent_events) {
      expect(ev).toHaveProperty("timestamp");
      expect(ev).toHaveProperty("type");
    }

    // JSON round-trip works
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    expect(parsed.type_counts).toEqual(data.type_counts);
  });

  it("gatherTree returns root and descendants", () => {
    const root = repo.createNode({
      type: "root_purpose",
      title: "Ship Trellis",
      body: "build it",
      status: "open",
      task_kind: "continuous",
      priority: 1,
      schedule: null,
      due_at: null,
      metadata: {},
    });

    const child = repo.createNode({
      type: "task",
      title: "Write tests",
      body: "unit tests",
      status: "open",
      task_kind: "oneoff",
      priority: 0.5,
      schedule: null,
      due_at: null,
      metadata: {},
    });

    repo.addEdge({
      from_id: child.id,
      to_id: root.id,
      type: "subtask_of",
      metadata: {},
    });

    const data = gatherTree(repo, root.id);
    expect(data).not.toBeNull();
    expect(data!.root.id).toBe(root.id);
    expect(data!.root.title).toBe("Ship Trellis");
    expect(data!.descendants).toHaveLength(1);
    expect(data!.descendants[0].id).toBe(child.id);

    // JSON round-trip
    const parsed = JSON.parse(JSON.stringify(data));
    expect(parsed.root.id).toBe(root.id);
    expect(parsed.descendants).toHaveLength(1);
  });

  it("gatherTree returns null for missing node", () => {
    expect(gatherTree(repo, "nonexistent-id")).toBeNull();
  });

  it("gatherSummary on empty graph has zero counts", () => {
    const data = gatherSummary(repo);
    expect(Object.keys(data.type_counts)).toHaveLength(0);
    expect(data.root_purposes).toHaveLength(0);
  });
});
