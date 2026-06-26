// UniMind adapter: a node's edges (both directions) + neighbors via dynamic queries.
import { NextRequest, NextResponse } from "next/server";
import { readBatch, g, NodeRef } from "@helix-db/helix-db";
import { runRead, toDataItem, toEdge, NODE_KEYS } from "@/lib/helix";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const nodeId = url.searchParams.get("node_id");
    if (!nodeId) return NextResponse.json({ error: "node_id parameter is required" }, { status: 400 });

    const numId = Number(nodeId);
    if (!Number.isInteger(numId)) {
      return NextResponse.json({ connected_nodes: [], incoming_edges: [], outgoing_edges: [] });
    }

    const req = readBatch()
      .varAs("out", g().n(NodeRef.id(numId)).outE().edgeProperties())
      .varAs("inc", g().n(NodeRef.id(numId)).inE().edgeProperties())
      .varAs("nbrs", g().n(NodeRef.id(numId)).both().valueMap(NODE_KEYS))
      .returning(["out", "inc", "nbrs"]);
    const res = await runRead(req.toDynamicRequest({ queryName: "viz_node_connections" }));

    return NextResponse.json({
      connected_nodes: (res.nbrs?.properties ?? []).map(toDataItem),
      outgoing_edges: (res.out?.properties ?? []).map(toEdge),
      incoming_edges: (res.inc?.properties ?? []).map(toEdge),
    });
  } catch (error) {
    console.error("node-connections:", error);
    return NextResponse.json({
      error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      connected_nodes: [], incoming_edges: [], outgoing_edges: [],
    });
  }
}
