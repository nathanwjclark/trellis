import { useEffect, useMemo, useState } from "react";
import { fetchGraph, fetchRecentEvents } from "./lib/api.js";
import { useEvents } from "./lib/useEvents.js";
import type { ApiNode, GraphResponse } from "./lib/types.js";
import { NodesTable } from "./components/NodesTable.js";
import { NodePanel } from "./components/NodePanel.js";
import { ActivityFeed } from "./components/ActivityFeed.js";
import { GraphCanvas } from "./components/GraphCanvas.js";

const REFRESH_INTERVAL_MS = 5000;
type ViewMode = "table" | "graph";

export function App() {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const { events, connected, seed } = useEvents(300);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async (): Promise<void> => {
      try {
        const g = await fetchGraph();
        if (!cancelled) {
          setGraph(g);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
        }
      }
    };

    refresh();
    fetchRecentEvents(50)
      .then((r) => {
        if (!cancelled) seed(r.events);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // seed identity is stable enough for this run; we deliberately only
    // run this effect on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh on most events too, so the table reflects writes from the daemon
  // without waiting for the 5s poll.
  const lastEventId = events[0]?.id ?? null;
  useEffect(() => {
    if (!lastEventId) return;
    fetchGraph()
      .then(setGraph)
      .catch(() => undefined);
  }, [lastEventId]);

  const byId = useMemo(() => {
    const m = new Map<string, ApiNode>();
    if (graph) for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>🦞 Trellis</h1>
        <span className="meta">
          {graph
            ? `${graph.counts.nodes} nodes · ${graph.counts.edges} edges`
            : "loading…"}
        </span>
        <div className="view-toggle">
          <button
            className={viewMode === "table" ? "active" : ""}
            onClick={() => setViewMode("table")}
          >
            table
          </button>
          <button
            className={viewMode === "graph" ? "active" : ""}
            onClick={() => setViewMode("graph")}
          >
            graph
          </button>
        </div>
        <span className="spacer" />
        {error && (
          <span style={{ color: "var(--red)", fontSize: 12 }}>
            api error: {error}
          </span>
        )}
        <span className="conn">
          <span className={`conn-dot ${connected ? "live" : ""}`} />
          {connected ? "live" : "reconnecting…"}
        </span>
      </header>
      <div className="app-body">
        {viewMode === "table" ? (
          <NodesTable
            nodes={graph?.nodes ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <GraphCanvas
            nodes={graph?.nodes ?? []}
            edges={graph?.edges ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
        <NodePanel
          selectedId={selectedId}
          byId={byId}
          onSelect={setSelectedId}
        />
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}
