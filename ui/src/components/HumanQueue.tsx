import { useEffect, useState } from "react";
import {
  fetchHumanQueue,
  resolveHumanQueueItem,
  type HumanQueueItem,
} from "../lib/api.js";

/**
 * Human queue: lists every task currently parked with status=human_blocked.
 * Lets Nathan unstick them with a text response (and a status choice —
 * usually "done", but he can also send back to "open" if his response
 * unblocks the agent rather than completing the task).
 */
export function HumanQueue() {
  const [items, setItems] = useState<HumanQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetchHumanQueue();
      setItems(r.items);
      setError(null);
      // Auto-select the first one if nothing's selected.
      if (!selectedId && r.items.length > 0) {
        setSelectedId(r.items[0]!.id);
      } else if (
        selectedId &&
        !r.items.some((i) => i.id === selectedId)
      ) {
        setSelectedId(r.items[0]?.id ?? null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selected = items?.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="hq-pane">
      <aside className="hq-list">
        <div className="hq-list-header">
          <h3>Needs You</h3>
          <button onClick={() => void load()}>refresh</button>
        </div>
        {error && <div className="hq-error">{error}</div>}
        {items === null && !error && (
          <div className="hq-empty">loading…</div>
        )}
        {items && items.length === 0 && (
          <div className="hq-empty">queue is empty</div>
        )}
        {items?.map((it) => (
          <button
            key={it.id}
            className={`hq-list-item ${selectedId === it.id ? "selected" : ""}`}
            onClick={() => setSelectedId(it.id)}
          >
            <div className="hq-item-title">{it.title}</div>
            <div className="hq-item-meta">
              prio {it.priority.toFixed(2)}
              {it.flagged_at && (
                <>
                  {" · "}
                  {timeAgo(it.flagged_at)}
                </>
              )}
              {it.parent && (
                <>
                  {" · "}
                  under {clip(it.parent.title, 30)}
                </>
              )}
            </div>
          </button>
        ))}
      </aside>
      <main className="hq-content">
        {selected ? (
          <ResolutionForm key={selected.id} item={selected} onResolved={load} />
        ) : (
          <div className="hq-empty">select an item</div>
        )}
      </main>
    </div>
  );
}

function ResolutionForm({
  item,
  onResolved,
}: {
  item: HumanQueueItem;
  onResolved: () => void | Promise<void>;
}) {
  const [response, setResponse] = useState("");
  const [status, setStatus] = useState<"done" | "open" | "cancelled">("done");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = async () => {
    if (!response.trim()) {
      setSubmitError("response cannot be empty");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await resolveHumanQueueItem(item.id, { response, status });
      setResponse("");
      await onResolved();
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="hq-resolution">
      <div className="hq-resolution-header">
        <h2>{item.title}</h2>
        <code className="hq-id">{item.id.slice(0, 8)}</code>
      </div>
      {item.parent && (
        <div className="hq-context-row">
          <span className="hq-context-label">parent:</span>{" "}
          <span>{item.parent.title}</span>
        </div>
      )}
      <div className="hq-context-row">
        <span className="hq-context-label">priority:</span>{" "}
        <span>{item.priority.toFixed(2)}</span>
      </div>
      {item.flagged_at && (
        <div className="hq-context-row">
          <span className="hq-context-label">flagged:</span>{" "}
          <span>{new Date(item.flagged_at).toLocaleString()}</span>
        </div>
      )}
      {item.human_blocker && (
        <>
          <div className="hq-section-label">What the agent needs from you</div>
          <div className="hq-blocker">{item.human_blocker}</div>
        </>
      )}
      {item.body && item.body.trim() && (
        <>
          <div className="hq-section-label">Task body</div>
          <pre className="hq-body">{item.body}</pre>
        </>
      )}
      <div className="hq-section-label">Your response</div>
      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="Answer, attach context, or say what to do next…"
        rows={6}
      />
      <div className="hq-form-row">
        <label>
          new status:{" "}
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as "done" | "open" | "cancelled")
            }
          >
            <option value="done">done — task complete</option>
            <option value="open">
              open — back to the queue, agent should retry with this info
            </option>
            <option value="cancelled">cancelled — kill the task</option>
          </select>
        </label>
        <button
          className="hq-submit"
          onClick={() => void submit()}
          disabled={submitting || !response.trim()}
        >
          {submitting ? "submitting…" : "submit"}
        </button>
      </div>
      {submitError && <div className="hq-error">{submitError}</div>}
    </div>
  );
}

function timeAgo(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
