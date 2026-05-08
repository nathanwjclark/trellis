import { useEffect, useMemo, useState } from "react";
import { fetchCycle, fetchCycles } from "../lib/api.js";
import type {
  CycleDetail,
  CycleSummary,
  CycleDump,
  CyclePhase,
} from "../lib/types.js";

const PURPOSE_COLORS: Record<string, string> = {
  extrapolate: "#7da9ff",
  index: "#9bd3c5",
  dedupe: "#b08eff",
  dedupe_sweep: "#b08eff",
  loop: "#e6b94a",
  execute: "#66c987",
};

export function CyclesView() {
  const [cycles, setCycles] = useState<CycleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CycleDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Refresh cycle list on mount + every 10s.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async (): Promise<void> => {
      try {
        const r = await fetchCycles(100);
        if (!cancelled) {
          setCycles(r.cycles);
          setError(null);
          if (!selectedId && r.cycles[0]) setSelectedId(r.cycles[0].short_id);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 10_000);
      }
    };
    refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load detail when selection changes.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    fetchCycle(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <>
      <div className="cycles-list">
        <div className="toolbar">
          <span style={{ color: "var(--text-dim)" }}>
            {cycles.length} cycles
          </span>
        </div>
        {error && <div className="empty">error: {error}</div>}
        {cycles.map((c) => (
          <div
            key={c.short_id}
            className={`cycle-row ${c.short_id === selectedId ? "selected" : ""}`}
            onClick={() => setSelectedId(c.short_id)}
          >
            <div className="cycle-row-head">
              <code>{c.short_id}</code>
              <span className="cycle-ts">{formatRelative(c.started_at)}</span>
            </div>
            <div className="cycle-row-purposes">
              {c.purposes.map((p) => (
                <span
                  key={p}
                  className="cycle-purpose-pill"
                  style={{ color: PURPOSE_COLORS[p] ?? "var(--text-dim)" }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="cycle-detail">
        {!selectedId && (
          <div className="empty">select a cycle from the list</div>
        )}
        {selectedId && loadingDetail && !detail && (
          <div className="empty">loading…</div>
        )}
        {detail && <CycleDetailView detail={detail} />}
      </div>
    </>
  );
}

function CycleDetailView({ detail }: { detail: CycleDetail }) {
  return (
    <div className="padded">
      <h2>cycle <code>{detail.short_id}</code></h2>
      <div className="meta">
        started {new Date(detail.started_at).toISOString()}
      </div>

      {detail.phases.map((phase) => (
        <PhaseSection key={phase.filename} phase={phase} />
      ))}

      {detail.dumps.length > 0 && (
        <>
          <h3>sidecar dumps</h3>
          {detail.dumps.map((d) => (
            <DumpSection key={d.filename} dump={d} />
          ))}
        </>
      )}
    </div>
  );
}

function PhaseSection({ phase }: { phase: CyclePhase }) {
  const summary = useMemo(() => summarizePhase(phase), [phase]);
  return (
    <details className="phase-section" open>
      <summary>
        <span
          className="cycle-purpose-pill"
          style={{ color: PURPOSE_COLORS[phase.purpose] ?? "var(--text-dim)" }}
        >
          {phase.purpose}
        </span>
        <span className="phase-summary">{summary}</span>
      </summary>
      <div className="phase-events">
        {phase.events.map((e, i) => (
          <EventLine key={i} event={e} startedAt={phase.started_at} />
        ))}
      </div>
    </details>
  );
}

function EventLine({
  event,
  startedAt,
}: {
  event: Record<string, unknown>;
  startedAt: number;
}) {
  const t = typeof event.t === "number" ? event.t : 0;
  const kind = typeof event.kind === "string" ? event.kind : "?";
  const offsetMs = t > 0 ? t - startedAt : 0;
  const rest = Object.fromEntries(
    Object.entries(event).filter(([k]) => k !== "t" && k !== "kind"),
  );
  const compact = compactKv(rest);
  return (
    <div className="phase-event">
      <span className="phase-event-t">+{(offsetMs / 1000).toFixed(2)}s</span>
      <span className="phase-event-kind">{kind}</span>
      {compact && <span className="phase-event-rest">{compact}</span>}
    </div>
  );
}

function compactKv(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === "object") {
      // Don't try to render objects inline; show their key count.
      const len = Array.isArray(v) ? v.length : Object.keys(v).length;
      parts.push(`${k}={${len}}`);
    } else if (typeof v === "string" && v.length > 60) {
      parts.push(`${k}="${v.slice(0, 60)}…"`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(" ");
}

function summarizePhase(phase: CyclePhase): string {
  const lastEvent = phase.events[phase.events.length - 1];
  const firstEvent = phase.events[0];
  const elapsedMs =
    firstEvent && lastEvent && typeof firstEvent.t === "number" && typeof lastEvent.t === "number"
      ? Number(lastEvent.t) - Number(firstEvent.t)
      : 0;
  return `${phase.events.length} events · ${(elapsedMs / 1000).toFixed(1)}s`;
}

function DumpSection({ dump }: { dump: CycleDump }) {
  const json = useMemo(() => {
    if (typeof dump.content === "string") return dump.content;
    return JSON.stringify(dump.content, null, 2);
  }, [dump.content]);
  const truncated = json.length > 4000 ? json.slice(0, 4000) + "\n…(truncated)" : json;
  return (
    <details className="phase-section">
      <summary>
        <span className="cycle-purpose-pill" style={{ color: "var(--text-dim)" }}>
          {dump.phase}
        </span>
        <span className="phase-summary">
          {dump.name} · {(json.length / 1024).toFixed(1)} KB
        </span>
      </summary>
      <pre className="dump-pre">{truncated}</pre>
    </details>
  );
}

function formatRelative(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return `${Math.max(1, Math.round(dt / 1000))}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}
