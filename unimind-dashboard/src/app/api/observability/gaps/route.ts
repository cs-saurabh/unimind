import { NextRequest, NextResponse } from "next/server";
import { g, Predicate, PropertyInput, readBatch, writeBatch } from "@helix-db/helix-db";

import { TENANT, runRead, runWrite } from "@/lib/helix";
import {
  gapPriority,
  gapState,
  gapTopic,
  parseGapPrompts,
  replaceStatusTag,
  type GapRecord,
  type GapRelatedMemory,
} from "@/lib/observability";

export const dynamic = "force-dynamic";

const GAP_KEYS = [
  "memoryId",
  "content",
  "tags",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "deletedAt",
  "confidence",
  "accessCount",
];

const RELATED_KEYS = [
  "memoryId",
  "content",
  "primaryType",
  "kind",
  "confidence",
];

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function mapRelated(row: any): GapRelatedMemory {
  return {
    memoryId: String(row.memoryId),
    content: String(row.content ?? ""),
    primaryType: String(row.primaryType ?? ""),
    kind: row.kind == null ? null : String(row.kind),
    confidence: typeof row.confidence === "number" ? row.confidence : Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
  };
}

function mapGap(row: any, relatedMemories: GapRelatedMemory[]): GapRecord {
  const tags = asStringArray(row.tags);
  return {
    memoryId: String(row.memoryId),
    content: String(row.content ?? ""),
    topic: gapTopic(tags, String(row.content ?? "")),
    priority: gapPriority(tags),
    state: gapState(tags, row.deletedAt == null ? null : String(row.deletedAt)),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
    expiresAt: row.expiresAt == null ? null : String(row.expiresAt),
    deletedAt: row.deletedAt == null ? null : String(row.deletedAt),
    confidence: typeof row.confidence === "number" ? row.confidence : Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
    accessCount: Number.isFinite(Number(row.accessCount)) ? Number(row.accessCount) : 0,
    prompts: parseGapPrompts(String(row.content ?? "")),
    tags,
    relatedMemories,
  };
}

function gapPredicate(memoryId?: string) {
  const parts = [
    Predicate.eq("tenant_id", TENANT),
    Predicate.eq("primaryType", "CONTEXTUAL"),
    Predicate.eq("kind", "knowledge_gap"),
    Predicate.eq("isLatest", true),
    Predicate.isNull("validTo"),
  ];
  if (memoryId) parts.push(Predicate.eq("memoryId", memoryId));
  return Predicate.and(parts);
}

export async function GET() {
  try {
    const gapsReq = readBatch()
      .varAs("gaps", g().nWithLabel("Memory").where(gapPredicate()).valueMap(GAP_KEYS))
      .returning(["gaps"]);
    const gapsRes = await runRead(gapsReq.toDynamicRequest({ queryName: "observability_gaps" }));
    const gapRows = (gapsRes.gaps?.properties ?? []).filter((row: any) => row.memoryId);

    let relatedReq = readBatch();
    const relatedVars: string[] = [];
    gapRows.forEach((row: any, index: number) => {
      const variable = `related_${index}`;
      relatedVars.push(variable);
      relatedReq = relatedReq.varAs(
        variable,
        g().nWithLabel("Memory")
          .where(Predicate.eq("memoryId", String(row.memoryId)))
          .out("RELATED_TO_THEME")
          .range(0, 6)
          .valueMap(RELATED_KEYS),
      );
    });

    const relatedRes = relatedVars.length > 0
      ? await runRead(relatedReq.returning(relatedVars).toDynamicRequest({ queryName: "observability_gap_related" }))
      : {};

    const gaps = gapRows
      .map((row: any, index: number) =>
        mapGap(
          row,
          ((relatedRes as any)[`related_${index}`]?.properties ?? []).map(mapRelated),
        ),
      )
      .sort((left, right) =>
        (left.state === right.state ? 0 : left.state === "open" ? -1 : 1) ||
        right.createdAt.localeCompare(left.createdAt),
      );

    return NextResponse.json({ gaps });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to load gap observability: ${error instanceof Error ? error.message : "Unknown error"}`,
        gaps: [],
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const memoryId = String(body?.memoryId ?? "");
    const action = body?.action === "reopen" ? "reopen" : body?.action === "close" ? "close" : null;

    if (!memoryId || !action) {
      return NextResponse.json({ error: "memoryId and action are required" }, { status: 400 });
    }

    const readReq = readBatch()
      .varAs("gap", g().nWithLabel("Memory").where(gapPredicate(memoryId)).valueMap(["memoryId", "tags", "deletedAt"]))
      .returning(["gap"]);
    const readRes = await runRead(readReq.toDynamicRequest({ queryName: "observability_gap_read" }));
    const row = readRes.gap?.properties?.[0];
    if (!row?.memoryId) {
      return NextResponse.json({ error: `Gap ${memoryId} not found` }, { status: 404 });
    }

    const now = new Date().toISOString();
    const nextTags = replaceStatusTag(asStringArray(row.tags), action === "close" ? "closed" : "open");

    let traversal = g().nWithLabel("Memory")
      .where(gapPredicate(memoryId))
      .setProperty("tags", PropertyInput.value(nextTags))
      .setProperty("updatedAt", PropertyInput.value(now));

    traversal = action === "close"
      ? traversal.setProperty("deletedAt", PropertyInput.value(now))
      : traversal.removeProperty("deletedAt");

    const writeReq = writeBatch()
      .varAs("gap", traversal)
      .returning(["gap"]);
    await runWrite(writeReq.toDynamicRequest({ queryName: "observability_gap_update" }));

    return NextResponse.json({
      ok: true,
      memoryId,
      action,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to update gap lifecycle: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      { status: 500 },
    );
  }
}
