import { useEffect, useMemo, useRef, useState } from "react";
import {
  exportTextUrl,
  fetchGraph,
  fetchGraphs,
  fetchRecentEvents,
  setActiveGraph,
  type GraphSummary,
} from "./lib/api.js";
import { useEvents } from "./lib/useEvents.js";
import type { ApiNode, GraphResponse } from "./lib/types.js";
import { NodesTable } from "./components/NodesTable.js";
import { NodePanel } from "./components/NodePanel.js";
import { ActivityFeed } from "./components/ActivityFeed.js";
import { GraphCanvas } from "./components/GraphCanvas.js";
import { CyclesView } from "./components/CyclesView.js";
import { ArtifactsBrowser } from "./components/ArtifactsBrowser.js";
import { IntrospectView } from "./components/IntrospectView.js";
import { HumanQueue } from "./components/HumanQueue.js";
import { CostsView } from "./components/CostsView.js";

const REFRESH_INTERVAL_MS = 5000;
// SSE event-triggered refetches are throttled this hard; a busy loop
// can produce dozens of node_created/edge_created events per second
// during extrapolation, and re-fetching+re-rendering the whole graph
// on each one is what made the dashboard feel like 1fpm.
const EVENT_REFETCH_THROTTLE_MS = 4000;
type ViewMode =
  | "table"
  | "graph"
  | "cycles"
  | "files"
  | "introspect"
  | "queue"
  | "costs";

export function App() {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [activeGraph, setActive] = useState<string | null>(null);
  const [availableGraphs, setAvailableGraphs] = useState<GraphSummary[]>([]);
  const [graphSwitching, setGraphSwitching] = useState(false);
  const { events, connected, seed } = useEvents(300);

  // Load the list of graphs + which is active. Refresh on switch.
  const loadGraphsList = async () => {
    try {
      const r = await fetchGraphs();
      setActive(r.active);
      setAvailableGraphs(r.graphs);
    } catch {
      // Older server without /api/graphs — leave dropdown hidden.
      setActive(null);
      setAvailableGraphs([]);
    }
  };
  useEffect(() => {
    void loadGraphsList();
  }, []);

  const onGraphChange = async (name: string) => {
    if (!name || name === activeGraph) return;
    setGraphSwitching(true);
    try {
      await setActiveGraph(name);
      // Force a complete re-fetch of everything that depends on the
      // graph identity. Cheapest correct way is to drop the loaded
      // graph state, refetch the list, refetch the graph.
      setGraph(null);
      setSelectedId(null);
      await loadGraphsList();
      const fresh = await fetchGraph();
      setGraph(fresh);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGraphSwitching(false);
    }
  };

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

  // Refresh on events, but throttled so a burst of N node_created
  // events doesn't fire N full-graph re-renders.
  const lastEventId = events[0]?.id ?? null;
  const lastEventRefetchAt = useRef(0);
  useEffect(() => {
    if (!lastEventId) return;
    const now = Date.now();
    if (now - lastEventRefetchAt.current < EVENT_REFETCH_THROTTLE_MS) return;
    lastEventRefetchAt.current = now;
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
    <div
      className={`app ${
        viewMode === "cycles"
          ? "cycles-mode"
          : viewMode === "introspect"
            ? "introspect-mode"
            : viewMode === "queue"
              ? "queue-mode"
              : viewMode === "costs"
                ? "costs-mode"
                : ""
      }`}
    >
      <header className="app-header">
        <h1>🦞 Trellis</h1>
        {availableGraphs.length > 0 && (
          <select
            className="graph-picker"
            value={activeGraph ?? ""}
            onChange={(e) => void onGraphChange(e.target.value)}
            disabled={graphSwitching}
            title="Switch active graph"
          >
            {availableGraphs.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
        )}
        <span className="meta">
          {graphSwitching
            ? "switching graph…"
            : graph
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
          <button
            className={viewMode === "files" ? "active" : ""}
            onClick={() => setViewMode("files")}
          >
            files
          </button>
          <button
            className={viewMode === "cycles" ? "active" : ""}
            onClick={() => setViewMode("cycles")}
          >
            cycles
          </button>
          <button
            className={viewMode === "introspect" ? "active" : ""}
            onClick={() => setViewMode("introspect")}
          >
            introspect
          </button>
          <button
            className={viewMode === "queue" ? "active" : ""}
            onClick={() => setViewMode("queue")}
          >
            needs you
          </button>
          <button
            className={viewMode === "costs" ? "active" : ""}
            onClick={() => setViewMode("costs")}
          >
            costs
          </button>
        </div>
        <a
          className="export-link"
          href={exportTextUrl()}
          download
          title="Download the entire graph as a hierarchical markdown document"
        >
          export ↓
        </a>
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
        {viewMode === "cycles" ? (
          <CyclesView />
        ) : viewMode === "files" ? (
          <ArtifactsBrowser />
        ) : viewMode === "introspect" ? (
          <IntrospectView />
        ) : viewMode === "queue" ? (
          <HumanQueue />
        ) : viewMode === "costs" ? (
          <CostsView />
        ) : (
          <>
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
          </>
        )}
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}
