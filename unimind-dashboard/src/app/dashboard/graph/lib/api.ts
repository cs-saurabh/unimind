// Single fetch that returns the whole connected graph (nodes WITH props + edges)
// in one request. No per-node detail/connection calls.

import { RawNode, RawEdge } from "../types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

export interface FetchGraphResult {
  nodes: RawNode[];
  edges: RawEdge[];
}

export async function fetchGraph(limit: number): Promise<FetchGraphResult> {
  const res = await fetch(`${API_BASE}/api/nodes-edges?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to load graph (HTTP ${res.status})`);
  }
  const json = await res.json();
  if (json?.error) {
    throw new Error(json.error);
  }
  return {
    nodes: json?.data?.nodes ?? [],
    edges: json?.data?.edges ?? [],
  };
}
