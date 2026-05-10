import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open } from "../src/graph/db.js";
import { Repo } from "../src/graph/repo.js";
import { capture } from "../src/cli/commands/capture.js";

let dbPath = "";
let dataDir = "";
let prevEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-capture-test-"));
  dbPath = path.join(dataDir, "trellis.db");
  prevEnv = { TRELLIS_DB_PATH: process.env.TRELLIS_DB_PATH };
  process.env.TRELLIS_DB_PATH = dbPath;
  // Initialize schema.
  const db = open({ path: dbPath });
  db.close();
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

function makeRoot(title = "Test root"): string {
  const db = open({ path: dbPath });
  const repo = new Repo(db);
  const root = repo.createNode({
    type: "root_purpose",
    title,
    body: "",
    status: "open",
    task_kind: "continuous",
    priority: 1,
    schedule: null,
    due_at: null,
    metadata: {},
  });
  db.close();
  return root.id;
}

describe("trellis capture", () => {
  it("creates a task under the sole open root_purpose", async () => {
    const rootId = makeRoot();
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      writes.push(typeof c === "string" ? c : c.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await capture({ title: "Investigate aquaponics wedge" });
    } finally {
      process.stdout.write = orig;
    }
    const out = writes.join("");
    const newId = out.split("\t")[0]!;

    const db = open({ path: dbPath });
    const repo = new Repo(db);
    const node = repo.getNode(newId)!;
    expect(node.type).toBe("task");
    expect(node.title).toBe("Investigate aquaponics wedge");
    expect(node.status).toBe("open");
    expect(node.priority).toBe(0.7);
    expect(node.metadata.source).toBe("chat");
    expect(typeof node.metadata.captured_at).toBe("number");

    // Verify edge: subtask_of root.
    const edges = db
      .prepare("SELECT * FROM edges WHERE from_id = ?")
      .all(newId) as Array<{ to_id: string; type: string }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to_id).toBe(rootId);
    expect(edges[0]!.type).toBe("subtask_of");
    db.close();
  });

  it("requires --title", async () => {
    makeRoot();
    await expect(capture({})).rejects.toThrow(/title/);
  });

  it("errors when no open root_purpose exists", async () => {
    await expect(capture({ title: "x" })).rejects.toThrow(/no open root_purpose/);
  });

  it("errors when multiple root_purposes exist and no --parent given", async () => {
    makeRoot("First");
    makeRoot("Second");
    await expect(capture({ title: "x" })).rejects.toThrow(/multiple open/);
  });

  it("respects --parent override", async () => {
    const a = makeRoot("First");
    const b = makeRoot("Second"); // ambiguous unless --parent
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      writes.push(typeof c === "string" ? c : c.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await capture({ title: "y", parent: b });
    } finally {
      process.stdout.write = orig;
    }
    const newId = writes.join("").split("\t")[0]!;
    const db = open({ path: dbPath });
    const edges = db
      .prepare("SELECT to_id FROM edges WHERE from_id = ?")
      .all(newId) as Array<{ to_id: string }>;
    expect(edges[0]!.to_id).toBe(b);
    expect(edges[0]!.to_id).not.toBe(a);
    db.close();
  });

  it("records source and session-id in metadata", async () => {
    makeRoot();
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      writes.push(typeof c === "string" ? c : c.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await capture({
        title: "x",
        source: "slack-thread",
        "session-id": "T123-C456-1234",
      });
    } finally {
      process.stdout.write = orig;
    }
    const newId = writes.join("").split("\t")[0]!;
    const db = open({ path: dbPath });
    const repo = new Repo(db);
    const node = repo.getNode(newId)!;
    expect(node.metadata.source).toBe("slack-thread");
    expect(node.metadata.session_id).toBe("T123-C456-1234");
    db.close();
  });

  it("custom --priority parses as number", async () => {
    makeRoot();
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      writes.push(typeof c === "string" ? c : c.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await capture({ title: "x", priority: "0.95" });
    } finally {
      process.stdout.write = orig;
    }
    const newId = writes.join("").split("\t")[0]!;
    const db = open({ path: dbPath });
    const repo = new Repo(db);
    expect(repo.getNode(newId)!.priority).toBe(0.95);
    db.close();
  });
});
