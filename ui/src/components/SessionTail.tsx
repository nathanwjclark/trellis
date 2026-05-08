import { useEffect, useRef, useState } from "react";
import { fetchSession } from "../lib/api.js";
import type { ApiNode, SessionDetail } from "../lib/types.js";

interface Props {
  /** The selected session-typed node. */
  sessionNode: ApiNode;
}

/**
 * Live tail of an OpenClaw subprocess's stdout/stderr for a session, with
 * the agent's result.json and a workspace file listing alongside.
 *
 * Subscribes to /api/sessions/:id/log/stream over SSE. The server sends an
 * "initial" frame with everything currently on disk, then incremental
 * "stdout"/"stderr" frames as the file grows.
 */
export function SessionTail({ sessionNode }: Props) {
  const sessionId =
    (sessionNode.metadata.session_id as string | undefined) ?? sessionNode.id;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const stdoutRef = useRef<HTMLPreElement | null>(null);
  const stderrRef = useRef<HTMLPreElement | null>(null);

  // Fetch detail on mount + when session changes.
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setStdout("");
    setStderr("");
    setError(null);
    fetchSession(sessionId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // SSE log tail.
  useEffect(() => {
    if (error) return;
    let stopped = false;
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/log/stream`;
    const es = new EventSource(url);
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => {
      setConnected(false);
      es.close();
    });
    es.addEventListener("stdout", (msg) => {
      if (stopped) return;
      try {
        const { chunk } = JSON.parse((msg as MessageEvent<string>).data);
        if (typeof chunk === "string") {
          setStdout((prev) => prev + chunk);
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener("stderr", (msg) => {
      if (stopped) return;
      try {
        const { chunk } = JSON.parse((msg as MessageEvent<string>).data);
        if (typeof chunk === "string") {
          setStderr((prev) => prev + chunk);
        }
      } catch {
        // ignore
      }
    });
    return () => {
      stopped = true;
      es.close();
    };
  }, [sessionId, error]);

  // Auto-scroll to bottom on growth.
  useEffect(() => {
    if (stdoutRef.current) {
      stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
    }
  }, [stdout]);
  useEffect(() => {
    if (stderrRef.current) {
      stderrRef.current.scrollTop = stderrRef.current.scrollHeight;
    }
  }, [stderr]);

  if (error) {
    return (
      <div className="session-tail">
        <h3>session</h3>
        <div className="empty" style={{ padding: 12 }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="session-tail">
      <h3>
        session{" "}
        <span className="conn" style={{ marginLeft: 8 }}>
          <span className={`conn-dot ${connected ? "live" : ""}`} />
          {connected ? "tailing" : "idle"}
        </span>
      </h3>
      <div className="session-meta">
        <code>{sessionId}</code>
        {detail && (
          <span style={{ color: "var(--text-faint)" }}>
            {" "}
            · stdout {fmtBytes(detail.stdout_size)} · stderr{" "}
            {fmtBytes(detail.stderr_size)}
          </span>
        )}
      </div>

      {detail?.result != null && (
        <>
          <h4>result.json</h4>
          <pre className="session-result">
            {JSON.stringify(detail.result, null, 2)}
          </pre>
        </>
      )}

      <h4>stdout</h4>
      <pre ref={stdoutRef} className="session-log">
        {stdout || <span className="dim">(empty)</span>}
      </pre>

      {(stderr || (detail && detail.stderr_size > 0)) && (
        <>
          <h4>stderr</h4>
          <pre ref={stderrRef} className="session-log session-log-err">
            {stderr || <span className="dim">(empty)</span>}
          </pre>
        </>
      )}

      {detail?.files && detail.files.length > 0 && (
        <>
          <h4>workspace files</h4>
          <div className="session-files">
            {detail.files.map((f) => (
              <div key={f.name} className="session-file">
                <span>{f.name}</span>
                <span className="dim">{fmtBytes(f.size)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
