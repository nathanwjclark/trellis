import { useEffect, useState } from "react";
import { fetchUsage, type UsageReport } from "../lib/api.js";

const SINCE_OPTIONS = [
  { label: "All time", value: "" },
  { label: "Last 1h", value: "1h" },
  { label: "Last 6h", value: "6h" },
  { label: "Last 24h", value: "24h" },
  { label: "Last 7d", value: "7d" },
];

/** Real-time-ish cost dashboard. Pulls llm_call events from the
 *  events table (every Anthropic call goes through recordUsage and
 *  lands as one) and aggregates. Refreshes on demand; polls every
 *  20s while the tab is open. */
export function CostsView() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetchUsage(since || undefined);
      setReport(r);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 20_000);
    return () => clearInterval(i);
  }, [since]);

  return (
    <div className="costs-pane">
      <div className="costs-header">
        <h2>Token Spend</h2>
        <div className="costs-controls">
          <select value={since} onChange={(e) => setSince(e.target.value)}>
            {SINCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button onClick={() => void load()} disabled={loading}>
            {loading ? "…" : "refresh"}
          </button>
        </div>
      </div>
      {error && <div className="costs-error">{error}</div>}
      {!report && !error && <div className="costs-loading">loading…</div>}
      {report && <CostsBody r={report} />}
    </div>
  );
}

function CostsBody({ r }: { r: UsageReport }) {
  return (
    <>
      <div className="costs-toplevel">
        <div className="costs-bigstat">
          <div className="cs-label">total spend</div>
          <div className="cs-value">${r.total_usd.toFixed(2)}</div>
        </div>
        <div className="costs-bigstat">
          <div className="cs-label">calls</div>
          <div className="cs-value">{r.total_calls}</div>
        </div>
        <div className="costs-bigstat">
          <div className="cs-label">input tokens</div>
          <div className="cs-value">{fmtNum(r.tokens.input)}</div>
        </div>
        <div className="costs-bigstat">
          <div className="cs-label">output tokens</div>
          <div className="cs-value">{fmtNum(r.tokens.output)}</div>
        </div>
      </div>

      <div className="costs-grid">
        <div className="costs-card">
          <h3>By model</h3>
          <table className="costs-table">
            <thead>
              <tr>
                <th>model</th>
                <th>calls</th>
                <th>$</th>
                <th>in tok</th>
                <th>out tok</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.by_model)
                .sort((a, b) => b[1].usd - a[1].usd)
                .map(([m, v]) => (
                  <tr key={m}>
                    <td className="mono">{m}</td>
                    <td>{v.calls}</td>
                    <td>${v.usd.toFixed(2)}</td>
                    <td>{fmtNum(v.in)}</td>
                    <td>{fmtNum(v.out)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="costs-card">
          <h3>By purpose</h3>
          <table className="costs-table">
            <thead>
              <tr>
                <th>purpose</th>
                <th>calls</th>
                <th>$</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.by_purpose)
                .sort((a, b) => b[1].usd - a[1].usd)
                .map(([p, v]) => (
                  <tr key={p}>
                    <td className="mono">{p}</td>
                    <td>{v.calls}</td>
                    <td>${v.usd.toFixed(2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="costs-card">
          <h3>Spend over time</h3>
          {r.time_buckets.length === 0 ? (
            <div className="costs-empty">no calls in this window</div>
          ) : (
            <div className="time-bars">
              {r.time_buckets.map((b, i) => {
                const max = Math.max(
                  0.001,
                  ...r.time_buckets.map((x) => x.usd),
                );
                const h = Math.round((b.usd / max) * 60);
                return (
                  <div
                    className="time-bar"
                    key={i}
                    title={`$${b.usd.toFixed(3)} · ${b.calls} calls`}
                  >
                    <div className="time-bar-stack">
                      <div
                        className="tb-created"
                        style={{ height: `${h}px` }}
                      />
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
          )}
        </div>

        <div className="costs-card costs-card-wide">
          <h3>Recent calls</h3>
          <table className="costs-table">
            <thead>
              <tr>
                <th>when</th>
                <th>model</th>
                <th>purpose</th>
                <th>$</th>
                <th>in</th>
                <th>out</th>
                <th>dur</th>
              </tr>
            </thead>
            <tbody>
              {r.recent.map((c, i) => (
                <tr key={i}>
                  <td>{timeAgo(c.t)}</td>
                  <td className="mono small">{c.model}</td>
                  <td className="mono small">{c.purpose}</td>
                  <td>${c.usd.toFixed(4)}</td>
                  <td>{fmtNum(c.input_tokens)}</td>
                  <td>{fmtNum(c.output_tokens)}</td>
                  <td>
                    {c.duration_ms
                      ? `${(c.duration_ms / 1000).toFixed(1)}s`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return `${Math.round(dt / 1000)}s`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h`;
  return `${Math.round(dt / 86_400_000)}d`;
}
