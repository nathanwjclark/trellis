import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 2,
    name: "add_verified_at",
    sql: `
      ALTER TABLE nodes ADD COLUMN verified_at INTEGER;
      CREATE INDEX idx_nodes_verified ON nodes(verified_at);
    `,
  },
  {
    id: 1,
    name: "init",
    sql: `
      CREATE TABLE nodes (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'n/a',
        task_kind       TEXT,
        priority        REAL NOT NULL DEFAULT 0.5,
        schedule        TEXT,
        due_at          INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        last_touched_at INTEGER NOT NULL,
        completed_at    INTEGER,
        metadata        TEXT NOT NULL DEFAULT '{}',
        revision        INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_nodes_type     ON nodes(type);
      CREATE INDEX idx_nodes_status   ON nodes(status);
      CREATE INDEX idx_nodes_touched  ON nodes(last_touched_at DESC);

      CREATE TABLE edges (
        id          TEXT PRIMARY KEY,
        from_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        to_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        weight      REAL NOT NULL DEFAULT 1,
        metadata    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        UNIQUE(from_id, to_id, type)
      );
      CREATE INDEX idx_edges_from ON edges(from_id, type);
      CREATE INDEX idx_edges_to   ON edges(to_id, type);
      CREATE INDEX idx_edges_type ON edges(type);

      CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        node_id     TEXT,
        edge_id     TEXT,
        payload     TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_events_created  ON events(created_at DESC);
      CREATE INDEX idx_events_node     ON events(node_id);
      CREATE INDEX idx_events_type     ON events(type);

      CREATE TABLE sessions (
        id              TEXT PRIMARY KEY,
        task_node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        workspace_path  TEXT NOT NULL,
        transcript_path TEXT,
        status          TEXT NOT NULL,
        tool_calls      INTEGER NOT NULL DEFAULT 0,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER,
        metadata        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_sessions_task   ON sessions(task_node_id);
      CREATE INDEX idx_sessions_status ON sessions(status);

      CREATE TABLE embeddings (
        node_id     TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        model       TEXT NOT NULL,
        dim         INTEGER NOT NULL,
        vector      BLOB NOT NULL,
        node_revision INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_embeddings_model ON embeddings(model);
    `,
  },
];

export interface OpenOptions {
  /** Filesystem path. Use ":memory:" for tests. */
  path: string;
  /** When true, runs PRAGMA journal_mode=WAL. Disabled for in-memory. */
  wal?: boolean;
}

export function open(options: OpenOptions): DB {
  if (options.path !== ":memory:") {
    const dir = path.dirname(options.path);
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(options.path);
  db.pragma("foreign_keys = ON");
  if (options.wal !== false && options.path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((r) => (r as { id: number }).id),
  );
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
  );
  // Apply in id order so dependent migrations run after their prerequisites.
  const sorted = [...MIGRATIONS].sort((a, b) => a.id - b.id);
  for (const m of sorted) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      insert.run(m.id, m.name, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function close(db: DB): void {
  db.close();
}
