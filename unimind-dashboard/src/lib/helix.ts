/**
 * UniMind adapter for the HelixDB dashboard.
 *
 * The OSS dashboard expects helix-db REST routes (/introspect, /nodes-by-label, …).
 * Our engine is enterprise-dev v3, which exposes ONLY `POST /v1/query` (dynamic
 * queries). This module bridges the gap: it builds dynamic queries with the same
 * DSL the app uses and shapes results into the dashboard's expected types.
 *
 * Powers the graph VISUALIZER (/dashboard/visualize). The query-browser
 * (/dashboard/queries) relies on stored named queries, which enterprise-dev does
 * not have, so that page stays empty by design.
 */
import { Client } from "@helix-db/helix-db";

const host = process.env.HELIX_HOST || "localhost";
const port = process.env.HELIX_PORT || "6969";
export const helix = new Client(`http://${host}:${port}`);

/** Tenant value for tenant-partitioned searches (BM25/vector). Matches the worker's tenant. */
export const TENANT = process.env.UNIMIND_TENANT || "unimind";

// enterprise-dev has no introspect; this is the known UniMind schema (§6).
// Shape matches what the dashboard's schema page expects: `properties` is an object
// (prop -> type), edges carry from_node/to_node, and there is a `vectors` array.
export const SCHEMA = {
  nodes: [
    { name: "Entity", node_type: "N", properties: { entityKey: "String", name: "String", entityType: "String", aliases: "[String]", confidence: "F64", createdAt: "DateTime", updatedAt: "DateTime" } },
    { name: "Memory", node_type: "N", properties: { memoryId: "String", primaryType: "String", content: "String", tags: "[String]", weight: "F64", confidence: "F64", isLatest: "Bool", status: "String", createdAt: "DateTime", lastAccessedAt: "DateTime", validFrom: "DateTime", validTo: "DateTime", expiresAt: "DateTime", decayPolicy: "String", accessCount: "I64" } },
    { name: "Category", node_type: "N", properties: { categoryKey: "String", name: "String" } },
    { name: "Session", node_type: "N", properties: { sessionId: "String", project: "String", startedAt: "DateTime", endedAt: "DateTime" } },
  ],
  edges: [
    { name: "MENTIONS", from_node: "Memory", to_node: "Entity", properties: { role: "String" } },
    { name: "REL", from_node: "Entity", to_node: "Entity", properties: { predicate: "String", subjectName: "String", objectName: "String", weight: "F64", validFrom: "DateTime", validTo: "DateTime" } },
    { name: "UPDATES", from_node: "Memory", to_node: "Memory", properties: { reason: "String", at: "DateTime" } },
    { name: "EXTENDS", from_node: "Memory", to_node: "Memory", properties: { confidence: "F64", at: "DateTime" } },
    { name: "DERIVES", from_node: "Memory", to_node: "Memory", properties: { confidence: "F64", at: "DateTime" } },
    { name: "IN_CATEGORY", from_node: "Memory", to_node: "Category", properties: { confidence: "F64" } },
    { name: "DERIVED_FROM", from_node: "Memory", to_node: "Session", properties: {} },
  ],
  vectors: [
    { name: "Memory", vector_type: "V", properties: { embedding: "[F64; 1536]" } },
    { name: "Entity", vector_type: "V", properties: { embedding: "[F64; 1536]" } },
  ],
};

export const NODE_LABELS = SCHEMA.nodes.map((n) => n.name);
export const EDGE_LABELS = SCHEMA.edges.map((e) => e.name);

// valueMap key set for nodes — union of all node props minus embeddings (never return vectors).
export const NODE_KEYS: string[] = [
  "$id", "$label",
  ...Array.from(new Set(SCHEMA.nodes.flatMap((n) => Object.keys(n.properties)))),
];

/** Map a raw Helix property row ($id/$label/props) into the dashboard's DataItem. */
export function toDataItem(row: any): any {
  const { $id, $label, ...rest } = row ?? {};
  return { id: String($id), label: $label, ...rest };
}

/** Map a raw edge property row into the dashboard's edge shape. */
export function toEdge(row: any): any {
  const { $id, $label, $from, $to, ...rest } = row ?? {};
  return { id: String($id), label: $label, from_node: String($from), to_node: String($to), ...rest };
}

export async function runRead(req: any): Promise<any> {
  return helix.query<any>().dynamic(req).send();
}
