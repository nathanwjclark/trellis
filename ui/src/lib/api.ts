import type {
  ApiEvent,
  GraphResponse,
  NodeDetailResponse,
  SessionDetail,
} from "./types.js";

const BASE = "/api";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export function fetchGraph(): Promise<GraphResponse> {
  return getJson<GraphResponse>("/graph");
}

export function fetchNode(id: string): Promise<NodeDetailResponse> {
  return getJson<NodeDetailResponse>(`/nodes/${encodeURIComponent(id)}`);
}

export function fetchRecentEvents(limit = 100): Promise<{ events: ApiEvent[] }> {
  return getJson<{ events: ApiEvent[] }>(`/events?limit=${limit}`);
}

export function fetchSession(id: string): Promise<SessionDetail> {
  return getJson<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
}

export function fetchCycles(limit = 100): Promise<{ cycles: import("./types.js").CycleSummary[] }> {
  return getJson<{ cycles: import("./types.js").CycleSummary[] }>(
    `/cycles?limit=${limit}`,
  );
}

export function fetchCycle(id: string): Promise<import("./types.js").CycleDetail> {
  return getJson<import("./types.js").CycleDetail>(
    `/cycles/${encodeURIComponent(id)}`,
  );
}

export interface ArtifactGroup {
  id: string;
  label: string;
  root: string;
  files: { path: string; size: number; mtime: number }[];
}

export function fetchArtifacts(): Promise<{ groups: ArtifactGroup[] }> {
  return getJson<{ groups: ArtifactGroup[] }>(`/artifacts`);
}

export function fetchArtifact(
  group: string,
  filePath: string,
): Promise<{ content: string; size: number; mtime: number; path: string }> {
  const q = new URLSearchParams({ group, path: filePath });
  return getJson<{
    content: string;
    size: number;
    mtime: number;
    path: string;
  }>(`/artifacts/file?${q.toString()}`);
}

/** URL for the export endpoint — used as the href of a download link
 *  rather than fetched into memory, so big graphs stream straight to
 *  disk. */
export function exportTextUrl(): string {
  return `${BASE}/export/text`;
}

export interface HumanQueueItem {
  id: string;
  title: string;
  body: string;
  priority: number;
  last_touched_at: number;
  flagged_at: number | null;
  flagged_by: string | null;
  human_blocker: string | null;
  human_response: string | null;
  attachments: unknown[];
  parent: { id: string; title: string; type: string } | null;
}
export function fetchHumanQueue(): Promise<{ items: HumanQueueItem[] }> {
  return getJson<{ items: HumanQueueItem[] }>(`/human-queue`);
}
export async function resolveHumanQueueItem(
  id: string,
  body: { response: string; status?: "done" | "open" | "cancelled" },
): Promise<{ ok: true; new_status: string }> {
  const res = await fetch(
    `${BASE}/human-queue/${encodeURIComponent(id)}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${t}`);
  }
  return (await res.json()) as { ok: true; new_status: string };
}

export interface UsageReport {
  since: number;
  total_calls: number;
  total_usd: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  by_model: Record<string, { calls: number; usd: number; in: number; out: number }>;
  by_purpose: Record<string, { calls: number; usd: number }>;
  time_buckets: { start: number; end: number; usd: number; calls: number }[];
  recent: {
    t: number;
    model: string;
    purpose: string;
    usd: number;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number | null;
    node_id: string | null;
  }[];
}
export function fetchUsage(since?: string): Promise<UsageReport> {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return getJson<UsageReport>(`/usage${q}`);
}
