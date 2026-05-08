import type { ApiEvent } from "../lib/types.js";

interface Props {
  events: ApiEvent[];
}

export function ActivityFeed({ events }: Props) {
  return (
    <div className="feed-pane">
      <h3>activity</h3>
      {events.length === 0 ? (
        <div className="empty" style={{ padding: 24, color: "var(--text-dim)" }}>
          waiting for events…
        </div>
      ) : (
        events.map((e) => (
          <div className="feed-event" key={e.id}>
            <span className="ts">{formatTime(e.created_at)}</span>
            <div>
              <span className={`ev-type ${e.type}`}>{e.type}</span>
              <div className="ev-meta">{summarize(e)}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function summarize(e: ApiEvent): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "node_created":
      return `${str(p.type)} "${str(p.title)}"`;
    case "cycle_phase_completed":
      return `${str(p.phase)} → ${num(p.new_nodes)} nodes / ${num(p.new_edges)} edges`;
    case "cycle_completed":
      return `${str(p.phase) || "cycle"} ${num(p.duration_ms) ? `${(num(p.duration_ms) / 1000).toFixed(1)}s` : ""}`;
    case "dedupe_decision":
      return `${str(p.decision)}${p.target_id ? ` → ${str(p.target_id).slice(0, 8)}…` : ""}`;
    case "session_started":
      return `${str(p.session_id).slice(0, 8)}…`;
    case "session_ended":
      return `ok=${p.ok ? "yes" : "no"} status=${str(p.applied_status)}`;
    case "llm_call":
      return `${str(p.model)} ${str(p.purpose)} · in=${num(p.input_tokens)} out=${num(p.output_tokens)} · $${num(p.usd_estimated).toFixed(4)}`;
    default:
      if (e.node_id) return `node ${e.node_id.slice(0, 8)}…`;
      return "";
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number.parseFloat(String(v ?? 0)) || 0;
}
