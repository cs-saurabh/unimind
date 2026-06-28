import { NextRequest, NextResponse } from "next/server";
import { readBatch, g, Predicate, Order } from "@helix-db/helix-db";
import { runRead, toDataItem, NODE_KEYS } from "@/lib/helix";

export const dynamic = "force-dynamic";

const MEMORY = "Memory";
const PAGE_SIZE = 50;
const FETCH_LIMIT = 5000;

export async function GET(request: NextRequest) {
  try {
    const p = new URL(request.url).searchParams;
    const offset = Math.max(0, parseInt(p.get("offset") ?? "0", 10));
    const q = p.get("q")?.toLowerCase() ?? "";
    const primaryType = p.get("primaryType") ?? "";
    const status = p.get("status") ?? "";
    const from = p.get("from") ?? "";
    const to = p.get("to") ?? "";

    const predicates: Predicate[] = [];
    if (primaryType) predicates.push(Predicate.eq("primaryType", primaryType.toUpperCase()));
    if (status) predicates.push(Predicate.eq("status", status));
    if (from && to) predicates.push(Predicate.between("createdAt", from, to));
    else if (from) predicates.push(Predicate.gte("createdAt", from));
    else if (to) predicates.push(Predicate.lte("createdAt", to));

    const base = g().nWithLabel(MEMORY);
    const filtered = predicates.length > 0
      ? base.where(predicates.length === 1 ? predicates[0] : Predicate.and(predicates))
      : base;
    const traversal = filtered.orderBy("createdAt", Order.Desc).range(0, FETCH_LIMIT).valueMap(NODE_KEYS);

    const res = await runRead(
      readBatch().varAs("m", traversal).returning(["m"])
        .toDynamicRequest({ queryName: "browse_memories" })
    );

    let rows: Record<string, unknown>[] = (res.m?.properties ?? []).map(toDataItem);

    if (q) rows = rows.filter((m) => String(m.content ?? "").toLowerCase().includes(q));

    const total = rows.length;
    const page = rows.slice(offset, offset + PAGE_SIZE);

    return NextResponse.json({ rows: page, total });
  } catch (error) {
    console.error("browse/memories:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
