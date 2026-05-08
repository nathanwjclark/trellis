import { useEffect, useState } from "react";
import { fetchNode } from "../lib/api.js";
import type { ApiEdge, ApiNode, NodeDetailResponse } from "../lib/types.js";
import { SessionTail } from "./SessionTail.js";

interface Props {
  selectedId: string | null;
  /** Map of all nodes from the latest /api/graph for resolving edge endpoints. */
  byId: Map<string, ApiNode>;
  onSelect: (id: string) => void;
}

export function NodePanel({ selectedId, byId, onSelect }: Props) {
  const [detail, setDetail] = useState<NodeDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNode(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (!selectedId) {
    return (
      <div className="detail-pane">
        <div className="empty">select a node from the table</div>
      </div>
    );
  }
  if (loading && !detail) {
    return (
      <div className="detail-pane">
        <div className="empty">loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="detail-pane">
        <div className="empty">error: {error}</div>
      </div>
    );
  }
  if (!detail) return null;

  const { node, edges } = detail;
  return (
    <div className="detail-pane">
      <div className="padded">
        <h2>{node.title}</h2>
        <div className="meta">
          <span className={`type-pill ${node.type}`}>{node.type}</span>{" "}
          <span className={`status-pill ${node.status}`}>{node.status}</span>{" "}
          {node.task_kind && (
            <span style={{ color: "var(--text-faint)" }}>· {node.task_kind}</span>
          )}{" "}
          <span style={{ color: "var(--text-faint)" }}>· prio {node.priority.toFixed(2)}</span>
        </div>
        <div className="meta" style={{ marginTop: 4 }}>
          <code>{node.id}</code>
        </div>

        <h3>body</h3>
        {node.body ? (
          <div className="body">{node.body}</div>
        ) : (
          <div className="meta" style={{ fontStyle: "italic" }}>
            (empty)
          </div>
        )}

        <EdgeList
          title="outgoing"
          edges={edges.outgoing}
          direction="outgoing"
          byId={byId}
          onSelect={onSelect}
        />
        <EdgeList
          title="incoming"
          edges={edges.incoming}
          direction="incoming"
          byId={byId}
          onSelect={onSelect}
        />

        {Object.keys(node.metadata).length > 0 && (
          <>
            <h3>metadata</h3>
            <pre
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--text-dim)",
                whiteSpace: "pre-wrap",
                background: "var(--bg-elev-1)",
                padding: 8,
                borderRadius: 4,
                margin: 0,
              }}
            >
              {JSON.stringify(node.metadata, null, 2)}
            </pre>
          </>
        )}

        {node.type === "session" && <SessionTail sessionNode={node} />}
      </div>
    </div>
  );
}

function EdgeList({
  title,
  edges,
  direction,
  byId,
  onSelect,
}: {
  title: string;
  edges: ApiEdge[];
  direction: "incoming" | "outgoing";
  byId: Map<string, ApiNode>;
  onSelect: (id: string) => void;
}) {
  if (edges.length === 0) return null;
  return (
    <>
      <h3>
        {title} ({edges.length})
      </h3>
      {edges.map((e) => {
        const otherId = direction === "outgoing" ? e.to_id : e.from_id;
        const other = byId.get(otherId);
        return (
          <div className="edge-row" key={e.id}>
            <span className="edge-type">{e.type}</span>
            <span className="edge-target" onClick={() => onSelect(otherId)}>
              {other ? `${other.title}` : `${otherId.slice(0, 8)}…`}
              {other && (
                <span
                  style={{ marginLeft: 6, color: "var(--text-faint)" }}
                  className={`status-pill ${other.status}`}
                >
                  ({other.status})
                </span>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
