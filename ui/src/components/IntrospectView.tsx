import { useEffect, useState } from "react";

interface AxisRow {
  count: number;
  fraction: number;
  edge_types: Record<string, number>;
}

interface IntrospectionReport {
  generated_at: number;
  graph_summary: {
    total_nodes: number;
    total_edges: number;
    by_status: Record<string, number>;
    spans_ms: { earliest: number; latest: number };
  };
  generative_vs_revision: {
    total_creations: number;
    total_updates: number;
    updates_per_node: number;
    revision_histogram: Record<string, number>;
    time_buckets: { start: number; end: number; created: number; updated: number }[];
  };
  axis_balance: {
    axes: Record<string, AxisRow>;
  };
  knowledge_capital: {
    thinking_count: number;
    doing_count: number;
    thinking_fraction: number;
    by_type: Record<string, number>;
    research_followthrough: { total: number; answered: number; unanswered: number };
  };
  re_extrapolation: {
    total_extrapolate_calls: number;
    on_previously_cycled_nodes: number;
    on_parent_after_descendant_executed: number;
    examples: { source_id: string; count: number }[];
  };
  lateral_movement: {
    scheduler_picks: number;
    distance_histogram: Record<string, number>;
    median_distance: number;
    mean_distance: number;
  };
  scheduler_rationales: {
    total_decisions: number;
    classified: { exploit: number; explore: number; neutral: number };
    examples: { exploit: string[]; explore: string[]; neutral: string[] };
  };
}

export function IntrospectView() {
  const [report, setReport] = useState<IntrospectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/introspect");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as IntrospectionReport;
      setReport(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="introspect-pane">
      <div className="introspect-header">
        <h2>Introspection</h2>
        <button onClick={() => void load()} disabled={loading}>
          {loading ? "computing…" : "refresh"}
        </button>
      </div>
      {error && <div className="introspect-error">{error}</div>}
      {!report && !error && <div className="introspect-loading">computing report…</div>}
      {report && <ReportBody r={report} />}
    </div>
  );
}

function ReportBody({ r }: { r: IntrospectionReport }) {
  const total = r.graph_summary.total_nodes || 1;
  const lmTotal = Math.max(1, r.lateral_movement.scheduler_picks - 1);
  const srTotal = Math.max(1, r.scheduler_rationales.total_decisions);
  return (
    <div className="introspect-grid">
      <div className="stat-card">
        <h3>1. Generative vs revision</h3>
        <div className="stat-summary">
          {r.generative_vs_revision.total_creations} created ·{" "}
          {r.generative_vs_revision.total_updates} updates ·{" "}
          <strong>{r.generative_vs_revision.updates_per_node}</strong> updates/node
        </div>
        <div className="stat-section">revision histogram</div>
        <div className="stat-bars">
          {(["1", "2", "3", "4+"] as const).map((k) => {
            const v = r.generative_vs_revision.revision_histogram[k] ?? 0;
            const pct = Math.round((v / total) * 100);
            return (
              <div className="bar-row" key={k}>
                <span className="bar-label">rev {k}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="bar-num">
                  {v} <span className="bar-pct">({pct}%)</span>
                </span>
              </div>
            );
          })}
        </div>
        {r.generative_vs_revision.time_buckets.length > 0 && (
          <>
            <div className="stat-section">activity over time</div>
            <div className="time-bars">
              {r.generative_vs_revision.time_buckets.map((b, i) => {
                const max = Math.max(
                  1,
                  ...r.generative_vs_revision.time_buckets.map(
                    (x) => x.created + x.updated,
                  ),
                );
                const cH = Math.round((b.created / max) * 60);
                const uH = Math.round((b.updated / max) * 60);
                return (
                  <div className="time-bar" key={i} title={`created ${b.created} · updated ${b.updated}`}>
                    <div className="time-bar-stack">
                      <div className="tb-created" style={{ height: `${cH}px` }} />
                      <div className="tb-updated" style={{ height: `${uH}px` }} />
                    </div>
                    <span className="time-bar-label">
                      {new Date(b.start).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="time-bars-legend">
              <span>
                <span className="tb-swatch tb-created-sw" /> created
              </span>
              <span>
                <span className="tb-swatch tb-updated-sw" /> updated
              </span>
            </div>
          </>
        )}
      </div>

      <div className="stat-card">
        <h3>2. Axis balance</h3>
        <div className="stat-bars">
          {(["down", "forward", "back", "up", "lateral", "other"] as const).map((k) => {
            const a = r.axis_balance.axes[k];
            if (!a) return null;
            const pct = Math.round(a.fraction * 100);
            return (
              <div className="bar-row" key={k}>
                <span className="bar-label">{k}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="bar-num">
                  {a.count} <span className="bar-pct">({pct}%)</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="stat-section">edge types</div>
        <div className="stat-detail">
          {Object.entries(r.axis_balance.axes).flatMap(([k, a]) =>
            Object.entries(a.edge_types).map(([t, n]) => (
              <span key={`${k}:${t}`} className="chip">
                {t}={n}
              </span>
            )),
          )}
        </div>
      </div>

      <div className="stat-card">
        <h3>3. Knowledge capital</h3>
        <div className="stat-summary">
          {r.knowledge_capital.thinking_count} thinking ·{" "}
          {r.knowledge_capital.doing_count} doing ·{" "}
          <strong>{Math.round(r.knowledge_capital.thinking_fraction * 100)}%</strong> thinking
        </div>
        <div className="stat-section">by type</div>
        <div className="stat-bars">
          {Object.entries(r.knowledge_capital.by_type)
            .sort((a, b) => b[1] - a[1])
            .map(([t, n]) => {
              const pct = Math.round((n / total) * 100);
              return (
                <div className="bar-row" key={t}>
                  <span className="bar-label">{t}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="bar-num">
                    {n} <span className="bar-pct">({pct}%)</span>
                  </span>
                </div>
              );
            })}
        </div>
        <div className="stat-section">research follow-through</div>
        <div className="stat-summary">
          {r.knowledge_capital.research_followthrough.answered} answered /{" "}
          {r.knowledge_capital.research_followthrough.total} created ·{" "}
          <strong>{r.knowledge_capital.research_followthrough.unanswered}</strong> unanswered
        </div>
      </div>

      <div className="stat-card">
        <h3>4. Re-extrapolation</h3>
        <div className="stat-summary">
          {r.re_extrapolation.total_extrapolate_calls} total extrapolate calls
        </div>
        <div className="stat-bars">
          <div className="bar-row">
            <span className="bar-label">re-cycled</span>
            <span className="bar-num">{r.re_extrapolation.on_previously_cycled_nodes}</span>
          </div>
          <div className="bar-row">
            <span className="bar-label">parent after exec</span>
            <span className="bar-num">{r.re_extrapolation.on_parent_after_descendant_executed}</span>
          </div>
        </div>
        {r.re_extrapolation.examples.length > 0 && (
          <>
            <div className="stat-section">most-revisited</div>
            <div className="stat-detail">
              {r.re_extrapolation.examples.map((ex) => (
                <span key={ex.source_id} className="chip">
                  {ex.source_id.slice(0, 8)} ×{ex.count}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="stat-card">
        <h3>5. Lateral movement</h3>
        <div className="stat-summary">
          {r.lateral_movement.scheduler_picks} picks · median distance{" "}
          <strong>{r.lateral_movement.median_distance}</strong> · mean{" "}
          {r.lateral_movement.mean_distance}
        </div>
        <div className="stat-section">distance from previous pick</div>
        <div className="stat-bars">
          {(["1", "2", "3", "4", "5+", "disconnected"] as const).map((k) => {
            const v = r.lateral_movement.distance_histogram[k] ?? 0;
            const pct = Math.round((v / lmTotal) * 100);
            return (
              <div className="bar-row" key={k}>
                <span className="bar-label">d={k}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="bar-num">
                  {v} <span className="bar-pct">({pct}%)</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="stat-card">
        <h3>6. Scheduler rationales</h3>
        <div className="stat-summary">
          {r.scheduler_rationales.total_decisions} decisions
        </div>
        <div className="stat-bars">
          {(["exploit", "explore", "neutral"] as const).map((k) => {
            const v = r.scheduler_rationales.classified[k];
            const pct = Math.round((v / srTotal) * 100);
            return (
              <div className="bar-row" key={k}>
                <span className="bar-label">{k}</span>
                <div className="bar-track">
                  <div className={`bar-fill bar-${k}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="bar-num">
                  {v} <span className="bar-pct">({pct}%)</span>
                </span>
              </div>
            );
          })}
        </div>
        {(["explore", "exploit", "neutral"] as const).map((k) =>
          r.scheduler_rationales.examples[k].length > 0 ? (
            <div key={k}>
              <div className="stat-section">example "{k}" rationales</div>
              <ul className="rationale-list">
                {r.scheduler_rationales.examples[k].map((ex, i) => (
                  <li key={i}>{ex}</li>
                ))}
              </ul>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
