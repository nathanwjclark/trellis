import { useEffect, useRef } from "react";
import cytoscape, {
  type Core,
  type ElementDefinition,
  type LayoutOptions,
} from "cytoscape";
import type { ApiEdge, ApiNode } from "../lib/types.js";

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const TYPE_COLORS: Record<string, string> = {
  task: "#7da9ff",
  root_purpose: "#b08eff",
  risk: "#e07b7b",
  scenario: "#e6b94a",
  outcome: "#66c987",
  rationale: "#a6c2ff",
  strategy: "#e6b94a",
  concept: "#9bd3c5",
  entity: "#d4a4d4",
  timeframe: "#d4a4d4",
  research: "#9bd3c5",
  note: "#9ca0aa",
  session: "#6c707a",
  memory: "#9bd3c5",
};

const EDGE_COLORS: Record<string, string> = {
  subtask_of: "#3b404c",
  ladders_up_to: "#b08eff",
  rationale_for: "#a6c2ff",
  risk_of: "#e07b7b",
  contingent_on: "#e6b94a",
  outcome_of: "#66c987",
  mentions: "#6c707a",
  relates_to: "#5a5e69",
  duplicate_of: "#3b404c",
  depends_on: "#7da9ff",
  produced_in_session: "#3b404c",
  derives_from: "#5a5e69",
  supersedes: "#5a5e69",
};

export function GraphCanvas({ nodes, edges, selectedId, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  // Stash the latest onSelect in a ref so the cy event listener attached on
  // mount always calls the freshest callback without re-binding.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Mount Cytoscape once.
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(label)",
            color: "#e7e9ee",
            "font-family":
              "ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif",
            "font-size": 9,
            "text-wrap": "ellipsis",
            "text-max-width": "120px",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "border-width": 1,
            "border-color": "#1c1f26",
            width: "data(size)" as unknown as number,
            height: "data(size)" as unknown as number,
            opacity: "data(opacity)" as unknown as number,
          },
        },
        {
          selector: 'node[status = "in_progress"]',
          style: {
            "border-width": 3,
            "border-color": "#e6b94a",
            "border-opacity": 0.9,
          },
        },
        {
          selector: 'node[status = "done"]',
          style: {
            opacity: 0.45,
          },
        },
        {
          selector: 'node[status = "blocked"]',
          style: {
            "border-width": 2,
            "border-color": "#e07b7b",
            "border-style": "dashed",
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 3,
            "border-color": "#a6c2ff",
            "border-opacity": 1,
            "z-index": 999,
          },
        },
        {
          selector: "edge",
          style: {
            "curve-style": "bezier",
            "line-color": "data(color)",
            width: "data(width)",
            opacity: 0.55,
            "target-arrow-shape": "triangle",
            "target-arrow-color": "data(color)",
            "arrow-scale": 0.6,
          },
        },
        {
          selector: "edge:selected",
          style: { opacity: 0.9, width: 2.5 },
        },
      ],
    });

    cy.on("tap", "node", (ev) => {
      const id = ev.target.id() as string;
      onSelectRef.current(id);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Sync graph data into Cytoscape on every change. We diff (add new + remove
  // gone) so we don't blow away the existing layout.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const newest = Math.max(...nodes.map((n) => n.last_touched_at), 1);
    const elements: ElementDefinition[] = [];
    for (const n of nodes) {
      elements.push({
        group: "nodes",
        data: {
          id: n.id,
          label: truncate(n.title, 32),
          type: n.type,
          status: n.status,
          color: TYPE_COLORS[n.type] ?? "#7da9ff",
          size: 12 + n.priority * 24,
          opacity: nodeOpacity(n.last_touched_at, newest),
        },
      });
    }
    for (const e of edges) {
      elements.push({
        group: "edges",
        data: {
          id: e.id,
          source: e.from_id,
          target: e.to_id,
          color: EDGE_COLORS[e.type] ?? "#3b404c",
          width: 0.5 + e.weight,
          edgeType: e.type,
        },
      });
    }
    // Keep a snapshot of existing ids so we know what to remove.
    const wantNodeIds = new Set(nodes.map((n) => n.id));
    const wantEdgeIds = new Set(edges.map((e) => e.id));
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (!wantNodeIds.has(n.id())) n.remove();
      });
      cy.edges().forEach((e) => {
        if (!wantEdgeIds.has(e.id())) e.remove();
      });
      // Upsert: if an element exists, update its data; else add.
      for (const el of elements) {
        const id = el.data.id as string;
        const existing = cy.getElementById(id);
        if (existing.nonempty()) {
          existing.data(el.data as Record<string, unknown>);
        } else {
          cy.add(el);
        }
      }
    });
    // Re-run the layout if the structure changed materially.
    runLayout(cy);
  }, [nodes, edges]);

  // Reflect external selection.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().unselect();
    if (selectedId) {
      const n = cy.getElementById(selectedId);
      if (n.nonempty()) {
        n.select();
        cy.animate({ center: { eles: n }, duration: 300 });
      }
    }
  }, [selectedId]);

  return (
    <div className="graph-pane">
      <div ref={containerRef} className="graph-canvas" />
      <Legend />
    </div>
  );
}

function Legend() {
  const types: { name: string; color: string }[] = [
    { name: "task", color: TYPE_COLORS.task ?? "" },
    { name: "root_purpose", color: TYPE_COLORS.root_purpose ?? "" },
    { name: "risk", color: TYPE_COLORS.risk ?? "" },
    { name: "rationale", color: TYPE_COLORS.rationale ?? "" },
    { name: "strategy", color: TYPE_COLORS.strategy ?? "" },
    { name: "outcome", color: TYPE_COLORS.outcome ?? "" },
    { name: "concept", color: TYPE_COLORS.concept ?? "" },
    { name: "session", color: TYPE_COLORS.session ?? "" },
  ];
  return (
    <div className="graph-legend">
      {types.map((t) => (
        <div className="graph-legend-item" key={t.name}>
          <span
            className="graph-legend-dot"
            style={{ background: t.color }}
          />
          <span>{t.name}</span>
        </div>
      ))}
      <div className="graph-legend-note">
        amber halo = in_progress · dim = done · dashed red border = blocked
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function nodeOpacity(lastTouchedAt: number, newest: number): number {
  // Map last_touched_at to opacity: most recent → 1.0, ancient → 0.55.
  const age = Math.max(0, newest - lastTouchedAt);
  const dayMs = 86_400_000;
  const t = Math.min(1, age / (3 * dayMs));
  return 1 - t * 0.45;
}

function runLayout(cy: Core): void {
  const opts = {
    name: "cose",
    animate: false,
    fit: true,
    padding: 30,
    nodeRepulsion: () => 8000,
    idealEdgeLength: () => 80,
    edgeElasticity: () => 100,
    gravity: 1,
    numIter: 1500,
  } as LayoutOptions;
  cy.layout(opts).run();
}
