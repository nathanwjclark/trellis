import { useEffect, useRef, useState } from "react";
import type { ApiEvent } from "./types.js";

/**
 * SSE subscription hook. Maintains a rolling buffer of the most recent
 * events. Auto-reconnects on close. `connected` reflects whether the
 * EventSource is currently OPEN.
 */
export function useEvents(maxBuffer = 200): {
  events: ApiEvent[];
  connected: boolean;
  /** Inject historical events on first paint without re-rendering for each. */
  seed: (events: ApiEvent[]) => void;
} {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const ref = useRef<EventSource | null>(null);

  useEffect(() => {
    let stopped = false;
    let backoff = 500;

    const connect = (): void => {
      if (stopped) return;
      const es = new EventSource("/api/events/stream");
      ref.current = es;
      es.addEventListener("open", () => {
        backoff = 500;
        setConnected(true);
      });
      es.addEventListener("error", () => {
        setConnected(false);
        es.close();
        ref.current = null;
        if (!stopped) {
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15_000);
        }
      });
      // Hono streams events via named SSE event types matching event.type;
      // catch them generically. We only attach to "message" plus our own
      // synthetic "ping" / "hello" — the real events come through with
      // custom event names, so use a wildcard via addEventListener with
      // each known type. To keep this simple, listen via .onmessage AND
      // a small set of known event types; the data field is identical.
      const onAny = (msg: MessageEvent<string>): void => {
        try {
          const event = JSON.parse(msg.data) as ApiEvent;
          if (!event || typeof event.id !== "string") return;
          setEvents((prev) => {
            const next = [event, ...prev];
            return next.slice(0, maxBuffer);
          });
        } catch {
          // Ignore malformed messages (heartbeats etc.).
        }
      };
      es.addEventListener("message", onAny as EventListener);
      const knownTypes = [
        "node_created",
        "node_updated",
        "node_archived",
        "edge_created",
        "edge_removed",
        "cycle_started",
        "cycle_phase_completed",
        "cycle_completed",
        "dedupe_decision",
        "session_started",
        "session_ended",
        "dream_started",
        "dream_proposal",
        "dream_applied",
        "llm_call",
      ];
      for (const t of knownTypes) {
        es.addEventListener(t, onAny as EventListener);
      }
    };

    connect();
    return () => {
      stopped = true;
      if (ref.current) ref.current.close();
      ref.current = null;
    };
  }, [maxBuffer]);

  const seed = (initial: ApiEvent[]): void => {
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const additions = initial.filter((e) => !seen.has(e.id));
      const next = [...prev, ...additions]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, maxBuffer);
      return next;
    });
  };

  return { events, connected, seed };
}
