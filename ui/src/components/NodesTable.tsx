import { useMemo, useState } from "react";
import type { ApiNode } from "../lib/types.js";

type SortKey = "title" | "type" | "status" | "priority" | "last_touched_at";

interface Props {
  nodes: ApiNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_OPTIONS = [
  "all",
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
  "n/a",
];

export function NodesTable({ nodes, selectedId, onSelect }: Props) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("last_touched_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) set.add(n.type);
    return ["all", ...Array.from(set).sort()];
  }, [nodes]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes
      .filter((n) => typeFilter === "all" || n.type === typeFilter)
      .filter((n) => statusFilter === "all" || n.status === statusFilter)
      .filter(
        (n) =>
          q === "" ||
          n.title.toLowerCase().includes(q) ||
          n.id.startsWith(q),
      )
      .sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        let cmp = 0;
        if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      });
  }, [nodes, search, typeFilter, statusFilter, sortKey, sortDir]);

  const setSort = (k: SortKey): void => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "title" ? "asc" : "desc");
    }
  };

  return (
    <div className="table-pane">
      <div className="toolbar">
        <input
          placeholder="search title or id…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.currentTarget.value)}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.currentTarget.value)}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span style={{ alignSelf: "center", color: "var(--text-dim)" }}>
          {filtered.length} / {nodes.length}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th onClick={() => setSort("type")}>type</th>
            <th onClick={() => setSort("title")}>title</th>
            <th onClick={() => setSort("status")}>status</th>
            <th
              onClick={() => setSort("priority")}
              style={{ textAlign: "right" }}
            >
              prio
            </th>
            <th
              onClick={() => setSort("last_touched_at")}
              style={{ textAlign: "right" }}
            >
              touched
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((n) => (
            <tr
              key={n.id}
              className={`selectable ${n.id === selectedId ? "selected" : ""}`}
              onClick={() => onSelect(n.id)}
            >
              <td>
                <span className={`type-pill ${n.type}`}>{n.type}</span>
              </td>
              <td>{n.title}</td>
              <td>
                <span className={`status-pill ${n.status}`}>{n.status}</span>
              </td>
              <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>
                {n.priority.toFixed(2)}
              </td>
              <td
                style={{
                  textAlign: "right",
                  fontFamily: "var(--mono)",
                  color: "var(--text-dim)",
                }}
              >
                {formatRelative(n.last_touched_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatRelative(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return `${Math.max(1, Math.round(dt / 1000))}s`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h`;
  return `${Math.round(dt / 86_400_000)}d`;
}
