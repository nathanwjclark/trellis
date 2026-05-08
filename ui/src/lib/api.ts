import type {
  ApiEvent,
  GraphResponse,
  NodeDetailResponse,
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
