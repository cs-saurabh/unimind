// UniMind adapter: whole-graph fetch (all node labels + edge labels) for graph visualization.
import { NextRequest, NextResponse } from "next/server";
import { readBatch, g } from "@helix-db/helix-db";
import { runRead, toDataItem, toEdge, NODE_KEYS, NODE_LABELS, EDGE_LABELS } from "@/lib/helix";

const MAX_LIMIT = 50000;

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10) || 500, MAX_LIMIT);
    const nodeLabel = url.searchParams.get("node_label");
    const labels = nodeLabel ? [nodeLabel] : NODE_LABELS;
    const perLabel = Math.max(1, Math.floor(limit / labels.length));

    let b = readBatch();
    labels.forEach((l) => { b = b.varAs(`n_${l}`, g().nWithLabel(l).range(0, perLabel).valueMap(NODE_KEYS)); });
    EDGE_LABELS.forEach((e) => { b = b.varAs(`e_${e}`, g().eWithLabel(e).range(0, limit).edgeProperties()); });
    const vars = [...labels.map((l) => `n_${l}`), ...EDGE_LABELS.map((e) => `e_${e}`)];
    const res = await runRead(b.returning(vars).toDynamicRequest({ queryName: "viz_nodes_edges" }));

    const nodes = labels.flatMap((l) => (res[`n_${l}`]?.properties ?? []).map(toDataItem));
    const edges = EDGE_LABELS.flatMap((e) => (res[`e_${e}`]?.properties ?? []).map(toEdge));
    return NextResponse.json({
      data: { nodes, edges, vectors: [] },
      stats: { num_nodes: nodes.length, num_edges: edges.length, num_vectors: 0 },
    });
  } catch (error) {
    console.error("nodes-edges:", error);
    return NextResponse.json({
      error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      data: { nodes: [], edges: [], vectors: [] },
    });
  }
}
