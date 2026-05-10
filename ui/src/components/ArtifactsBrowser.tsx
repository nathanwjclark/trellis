import { useEffect, useMemo, useState } from "react";
import {
  fetchArtifact,
  fetchArtifacts,
  type ArtifactGroup,
} from "../lib/api.js";

interface Selection {
  group: string;
  path: string;
}

export function ArtifactsBrowser() {
  const [groups, setGroups] = useState<ArtifactGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchArtifacts()
      .then((r) => {
        if (cancelled) return;
        setGroups(r.groups);
        // Auto-select the first file (workspace usually has the bulk).
        const first = r.groups.find((g) => g.files.length > 0);
        if (first && first.files[0]) {
          setSelection({ group: first.id, path: first.files[0].path });
        }
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selection) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    fetchArtifact(selection.group, selection.path)
      .then((r) => {
        if (!cancelled) setContent(r.content);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setContent(
            `<error loading file: ${e instanceof Error ? e.message : String(e)}>`,
          );
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const filteredGroups = useMemo(() => {
    if (!groups) return null;
    if (!filter.trim()) return groups;
    const q = filter.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        files: g.files.filter(
          (f) =>
            f.path.toLowerCase().includes(q) ||
            g.label.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.files.length > 0);
  }, [groups, filter]);

  return (
    <div className="artifacts-pane">
      <aside className="artifacts-list">
        <div className="artifacts-search">
          <input
            type="text"
            placeholder="filter by filename…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {error && <div className="artifacts-error">api: {error}</div>}
        {filteredGroups === null && !error && (
          <div className="artifacts-empty">loading…</div>
        )}
        {filteredGroups && filteredGroups.length === 0 && (
          <div className="artifacts-empty">
            no artifacts found
            {filter ? " matching filter" : ""}
          </div>
        )}
        {filteredGroups?.map((g) => (
          <div key={g.id} className="artifacts-group">
            <div className="artifacts-group-label">
              {g.label}
              <span className="artifacts-count">{g.files.length}</span>
            </div>
            <ul>
              {g.files.map((f) => {
                const isSel =
                  selection?.group === g.id && selection?.path === f.path;
                return (
                  <li key={`${g.id}:${f.path}`}>
                    <button
                      type="button"
                      className={isSel ? "selected" : ""}
                      onClick={() =>
                        setSelection({ group: g.id, path: f.path })
                      }
                      title={`${f.path} · ${f.size} bytes · ${new Date(
                        f.mtime,
                      ).toLocaleString()}`}
                    >
                      <span className="artifact-name">{f.path}</span>
                      <span className="artifact-meta">
                        {humanSize(f.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </aside>
      <main className="artifacts-content">
        {selection ? (
          <>
            <div className="artifacts-content-header">
              <span className="artifacts-content-path">{selection.path}</span>
            </div>
            <pre className="artifacts-content-body">
              {contentLoading ? "loading…" : (content ?? "")}
            </pre>
          </>
        ) : (
          <div className="artifacts-empty">select a file</div>
        )}
      </main>
    </div>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
