import { NextRequest, NextResponse } from "next/server";
import {
  NodeRef,
  Predicate,
  PropertyInput,
  g,
  readBatch,
  writeBatch,
} from "@helix-db/helix-db";

import { TENANT, runRead, runWrite } from "@/lib/helix";
import {
  pairKey,
  type ContradictionMemory,
  type ContradictionPair,
} from "@/lib/observability";

export const dynamic = "force-dynamic";

const MEMORY_KEYS = [
  "$id",
  "memoryId",
  "content",
  "confidence",
  "primaryType",
  "kind",
  "createdAt",
  "updatedAt",
  "lastRevisedAt",
  "contradictions",
  "hasContradiction",
];

interface ContradictionRecord {
  withMemoryId: string;
  resolution: string;
  confidence: number;
  resolvedAt: string;
}

function contradictionPredicate(memoryId?: string) {
  const parts = [
    Predicate.eq("tenant_id", TENANT),
    Predicate.eq("isLatest", true),
    Predicate.isNull("validTo"),
    Predicate.isNull("deletedAt"),
    Predicate.eq("hasContradiction", true),
  ];
  if (memoryId) parts.push(Predicate.eq("memoryId", memoryId));
  return Predicate.and(parts);
}

function asContradictions(value: unknown): ContradictionRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      withMemoryId: String((entry as any)?.withMemoryId ?? ""),
      resolution: String((entry as any)?.resolution ?? ""),
      confidence: Number((entry as any)?.confidence ?? 0),
      resolvedAt: String((entry as any)?.resolvedAt ?? ""),
    }))
    .filter((entry) => entry.withMemoryId);
}

function toMemory(row: any): ContradictionMemory {
  return {
    memoryId: String(row.memoryId),
    content: String(row.content ?? ""),
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0,
    primaryType: String(row.primaryType ?? ""),
    kind: row.kind == null ? null : String(row.kind),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
    lastRevisedAt: row.lastRevisedAt == null ? null : String(row.lastRevisedAt),
  };
}

export async function GET() {
  try {
    const req = readBatch()
      .varAs(
        "memories",
        g().nWithLabel("Memory").where(contradictionPredicate()).valueMap(MEMORY_KEYS),
      )
      .varAs("edges", g().eWithLabel("CONTRADICTS").edgeProperties())
      .returning(["memories", "edges"]);
    const res = await runRead(req.toDynamicRequest({ queryName: "observability_contradictions" }));

    const memoryRows = (res.memories?.properties ?? []).filter((row: any) => row.memoryId);
    const memoryById = new Map<string, any>();
    const graphNodeToMemoryId = new Map<string, string>();
    memoryRows.forEach((row: any) => {
      const memoryId = String(row.memoryId);
      memoryById.set(memoryId, row);
      graphNodeToMemoryId.set(String(row.$id), memoryId);
    });

    const linkedPairs = new Set<string>();
    for (const edge of res.edges?.properties ?? []) {
      const fromMemoryId = graphNodeToMemoryId.get(String(edge.$from));
      const toMemoryId = graphNodeToMemoryId.get(String(edge.$to));
      if (!fromMemoryId || !toMemoryId) continue;
      linkedPairs.add(pairKey(fromMemoryId, toMemoryId));
    }

    const seen = new Set<string>();
    const contradictions: ContradictionPair[] = [];

    for (const row of memoryRows) {
      const currentMemoryId = String(row.memoryId);
      const currentMemory = toMemory(row);

      for (const entry of asContradictions(row.contradictions)) {
        const otherRow = memoryById.get(entry.withMemoryId);
        if (!otherRow) continue;

        const key = pairKey(currentMemoryId, entry.withMemoryId);
        if (seen.has(key) || !linkedPairs.has(key)) continue;
        seen.add(key);

        const otherMemory = toMemory(otherRow);
        const left = currentMemory.memoryId <= otherMemory.memoryId ? currentMemory : otherMemory;
        const right = left.memoryId === currentMemory.memoryId ? otherMemory : currentMemory;

        contradictions.push({
          key,
          note: entry.resolution,
          confidence: Number.isFinite(entry.confidence) ? entry.confidence : 0,
          resolvedAt: entry.resolvedAt,
          left,
          right,
        });
      }
    }

    contradictions.sort((left, right) => right.resolvedAt.localeCompare(left.resolvedAt));

    return NextResponse.json({ contradictions });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to load contradiction observability: ${error instanceof Error ? error.message : "Unknown error"}`,
        contradictions: [],
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const leftMemoryId = String(body?.leftMemoryId ?? "");
    const rightMemoryId = String(body?.rightMemoryId ?? "");

    if (!leftMemoryId || !rightMemoryId) {
      return NextResponse.json({ error: "leftMemoryId and rightMemoryId are required" }, { status: 400 });
    }

    const readReq = readBatch()
      .varAs("left", g().nWithLabel("Memory").where(contradictionPredicate(leftMemoryId)).valueMap(["memoryId", "contradictions"]))
      .varAs("right", g().nWithLabel("Memory").where(contradictionPredicate(rightMemoryId)).valueMap(["memoryId", "contradictions"]))
      .returning(["left", "right"]);
    const readRes = await runRead(readReq.toDynamicRequest({ queryName: "observability_contradiction_read" }));

    const leftRow = readRes.left?.properties?.[0];
    const rightRow = readRes.right?.properties?.[0];
    if (!leftRow?.memoryId || !rightRow?.memoryId) {
      return NextResponse.json({ error: "Contradiction pair not found" }, { status: 404 });
    }

    const nextLeft = asContradictions(leftRow.contradictions).filter((entry) => entry.withMemoryId !== rightMemoryId);
    const nextRight = asContradictions(rightRow.contradictions).filter((entry) => entry.withMemoryId !== leftMemoryId);
    const now = new Date().toISOString();

    let leftTraversal = g().nWithLabel("Memory")
      .where(Predicate.and([Predicate.eq("tenant_id", TENANT), Predicate.eq("memoryId", leftMemoryId)]))
      .setProperty("hasContradiction", PropertyInput.value(nextLeft.length > 0))
      .setProperty("updatedAt", PropertyInput.value(now));
    leftTraversal = nextLeft.length > 0
      ? leftTraversal.setProperty("contradictions", PropertyInput.value(nextLeft))
      : leftTraversal.removeProperty("contradictions");

    let rightTraversal = g().nWithLabel("Memory")
      .where(Predicate.and([Predicate.eq("tenant_id", TENANT), Predicate.eq("memoryId", rightMemoryId)]))
      .setProperty("hasContradiction", PropertyInput.value(nextRight.length > 0))
      .setProperty("updatedAt", PropertyInput.value(now));
    rightTraversal = nextRight.length > 0
      ? rightTraversal.setProperty("contradictions", PropertyInput.value(nextRight))
      : rightTraversal.removeProperty("contradictions");

    const writeReq = writeBatch()
      .varAs("left", leftTraversal)
      .varAs("right", rightTraversal)
      .varAs("drop_left", g().n(NodeRef.var("left")).dropEdgeLabeled(NodeRef.var("right"), "CONTRADICTS"))
      .varAs("drop_right", g().n(NodeRef.var("right")).dropEdgeLabeled(NodeRef.var("left"), "CONTRADICTS"))
      .returning(["left", "right", "drop_left", "drop_right"]);
    await runWrite(writeReq.toDynamicRequest({ queryName: "observability_contradiction_dismiss" }));

    return NextResponse.json({ ok: true, leftMemoryId, rightMemoryId });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to dismiss contradiction: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      { status: 500 },
    );
  }
}
