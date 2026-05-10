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
