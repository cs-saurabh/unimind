// UniMind adapter: a single node by internal id via a dynamic query.
import { NextRequest, NextResponse } from "next/server";
import { readBatch, g, NodeRef } from "@helix-db/helix-db";
import { runRead, toDataItem, NODE_KEYS } from "@/lib/helix";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID parameter is required" }, { status: 400 });

    const numId = Number(id);
    if (!Number.isInteger(numId)) return NextResponse.json({ found: false, error: "id must be an integer" });

    const req = readBatch()
      .varAs("n", g().n(NodeRef.id(numId)).valueMap(NODE_KEYS))
      .returning(["n"]);
    const res = await runRead(req.toDynamicRequest({ queryName: "viz_node_details" }));
    const row = (res.n?.properties ?? [])[0];
    if (!row) return NextResponse.json({ found: false });
    return NextResponse.json({ found: true, node: toDataItem(row) });
  } catch (error) {
    console.error("node-details:", error);
    return NextResponse.json({ found: false, error: error instanceof Error ? error.message : "Unknown error" });
  }
}
