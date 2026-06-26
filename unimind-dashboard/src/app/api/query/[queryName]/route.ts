// UniMind adapter: execute the curated query-browser "endpoints" (see /api/endpoints)
// by dispatching each to a dynamic /v1/query against enterprise-dev. Replaces the
// helix-ts stored-query client, which enterprise-dev does not support.
import { NextRequest, NextResponse } from "next/server";
import { readBatch, g, Predicate, PropertyInput, Expr, Order } from "@helix-db/helix-db";
import { runRead, toDataItem, toEdge, NODE_KEYS, TENANT } from "@/lib/helix";

const MEMORY = "Memory";
const ENTITY = "Entity";
const REL = "REL";

const clampLimit = (v: string | null, def = 50) => Math.min(Math.max(parseInt(v || String(def), 10) || def, 1), 1000);

async function execute(queryName: string, p: URLSearchParams): Promise<any> {
  switch (queryName) {
    case "getMemories": {
      const limit = clampLimit(p.get("limit"));
      const res = await runRead(readBatch().varAs("m", g().nWithLabel(MEMORY)
        .orderBy("createdAt", Order.Desc).range(0, limit).valueMap(NODE_KEYS)).returning(["m"])
        .toDynamicRequest({ queryName: "qb_getMemories" }));
      return { memories: (res.m?.properties ?? []).map(toDataItem) };
    }
    case "searchMemories": {
      const text = p.get("text") ?? "";
      const limit = clampLimit(p.get("limit"), 20);
      const res = await runRead(readBatch().varAs("m", g().textSearchNodesWith(MEMORY, "content",
        PropertyInput.value(text), Expr.val(limit), PropertyInput.value(TENANT)).valueMap(NODE_KEYS)).returning(["m"])
        .toDynamicRequest({ queryName: "qb_searchMemories" }));
      return { memories: (res.m?.properties ?? []).map(toDataItem) };
    }
    case "getMemoriesByType": {
      const primaryType = (p.get("primaryType") ?? "").toUpperCase();
      const limit = clampLimit(p.get("limit"));
      const res = await runRead(readBatch().varAs("m", g().nWithLabel(MEMORY)
        .where(Predicate.eq("primaryType", primaryType)).range(0, limit).valueMap(NODE_KEYS)).returning(["m"])
        .toDynamicRequest({ queryName: "qb_getMemoriesByType" }));
      return { primaryType, memories: (res.m?.properties ?? []).map(toDataItem) };
    }
    case "getGoals": {
      const res = await runRead(readBatch().varAs("m", g().nWithLabel(MEMORY)
        .where(Predicate.eq("primaryType", "GOAL")).range(0, 100).valueMap(NODE_KEYS)).returning(["m"])
        .toDynamicRequest({ queryName: "qb_getGoals" }));
      return { goals: (res.m?.properties ?? []).map(toDataItem) };
    }
    case "getEntities": {
      const limit = clampLimit(p.get("limit"));
      const res = await runRead(readBatch().varAs("e", g().nWithLabel(ENTITY)
        .range(0, limit).valueMap(NODE_KEYS)).returning(["e"])
        .toDynamicRequest({ queryName: "qb_getEntities" }));
      return { entities: (res.e?.properties ?? []).map(toDataItem) };
    }
    case "getEntityRelations": {
      const name = p.get("name") ?? "";
      const res = await runRead(readBatch().varAs("rels", g().nWithLabel(ENTITY)
        .where(Predicate.eq("name", name)).bothE(REL).edgeProperties()).returning(["rels"])
        .toDynamicRequest({ queryName: "qb_getEntityRelations" }));
      return { entity: name, relations: (res.rels?.properties ?? []).map(toEdge) };
    }
    default:
      return { error: `Unknown query "${queryName}". See /api/endpoints for available operations.` };
  }
}

async function handle(request: NextRequest, queryName: string) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;
    // GET params live in the query string; merge any JSON body for POST/PUT just in case.
    if (request.method === "POST" || request.method === "PUT") {
      try {
        const body = await request.json();
        for (const [k, v] of Object.entries(body ?? {})) params.set(k, String(v));
      } catch { /* no body */ }
    }
    const result = await execute(queryName, params);
    return NextResponse.json(result);
  } catch (error) {
    console.error(`query '${queryName}':`, error);
    return NextResponse.json(
      { error: `Failed to execute query: ${error instanceof Error ? error.message : "Unknown error"}`, query: queryName },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ queryName: string }> }) {
  return handle(request, (await params).queryName);
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ queryName: string }> }) {
  return handle(request, (await params).queryName);
}
