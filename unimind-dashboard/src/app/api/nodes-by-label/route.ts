// UniMind adapter: nodes of a label via a dynamic query against enterprise-dev /v1/query.
import { NextRequest, NextResponse } from "next/server";
import { readBatch, g } from "@helix-db/helix-db";
import { runRead, toDataItem, NODE_KEYS } from "@/lib/helix";

const MAX_LIMIT = 3000;

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const label = url.searchParams.get("label");
    const limitParam = url.searchParams.get("limit");
    if (!label) return NextResponse.json({ error: "Label parameter is required" }, { status: 400 });

    const limit = Math.min(parseInt(limitParam || "200", 10) || 200, MAX_LIMIT);
    const req = readBatch()
      .varAs("nodes", g().nWithLabel(label).range(0, limit).valueMap(NODE_KEYS))
      .returning(["nodes"]);
    const res = await runRead(req.toDynamicRequest({ queryName: "viz_nodes_by_label" }));
    const nodes = (res.nodes?.properties ?? []).map(toDataItem);
    return NextResponse.json({ nodes });
  } catch (error) {
    console.error("nodes-by-label:", error);
    return NextResponse.json({
      error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      nodes: [],
    });
  }
}
