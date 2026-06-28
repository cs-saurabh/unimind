import { NextRequest, NextResponse } from "next/server";
import { readBatch, g, Predicate, Order } from "@helix-db/helix-db";
import { runRead, toDataItem, NODE_KEYS } from "@/lib/helix";

export const dynamic = "force-dynamic";

const ENTITY = "Entity";
const PAGE_SIZE = 50;
const FETCH_LIMIT = 5000;

export async function GET(request: NextRequest) {
  try {
    const p = new URL(request.url).searchParams;
    const offset = Math.max(0, parseInt(p.get("offset") ?? "0", 10));
    const q = p.get("q")?.toLowerCase() ?? "";
    const entityType = p.get("entityType") ?? "";
    const from = p.get("from") ?? "";
    const to = p.get("to") ?? "";

    const predicates: Predicate[] = [];
    if (entityType) predicates.push(Predicate.eq("entityType", entityType));
    if (from && to) predicates.push(Predicate.between("createdAt", from, to));
    else if (from) predicates.push(Predicate.gte("createdAt", from));
    else if (to) predicates.push(Predicate.lte("createdAt", to));

    const base = g().nWithLabel(ENTITY);
    const filtered = predicates.length > 0
      ? base.where(predicates.length === 1 ? predicates[0] : Predicate.and(predicates))
      : base;
    const traversal = filtered.orderBy("createdAt", Order.Desc).range(0, FETCH_LIMIT).valueMap(NODE_KEYS);

    const res = await runRead(
      readBatch().varAs("e", traversal).returning(["e"])
        .toDynamicRequest({ queryName: "browse_entities" })
    );

    let rows: Record<string, unknown>[] = (res.e?.properties ?? []).map(toDataItem);

    if (q) {
      rows = rows.filter((e) => {
        const name = String(e.name ?? "").toLowerCase();
        const key = String(e.entityKey ?? "").toLowerCase();
        const aliases = Array.isArray(e.aliases)
          ? e.aliases.map((a) => String(a).toLowerCase())
          : [];
        return name.includes(q) || key.includes(q) || aliases.some((a) => a.includes(q));
      });
    }

    const total = rows.length;
    const page = rows.slice(offset, offset + PAGE_SIZE);

    return NextResponse.json({ rows: page, total });
  } catch (error) {
    console.error("browse/entities:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
