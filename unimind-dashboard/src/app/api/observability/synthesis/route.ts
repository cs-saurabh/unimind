import { NextResponse } from "next/server";
import { g, Predicate, readBatch } from "@helix-db/helix-db";

import { TENANT, runRead } from "@/lib/helix";
import {
  synthesisResult,
  type InsightLink,
  type SynthesisRun,
  type SynthesisSweepDetails,
} from "@/lib/observability";

export const dynamic = "force-dynamic";

const WORKER_AUDIT_URL = process.env.WORKER_AUDIT_URL || "http://localhost:48180";
const AUDIT_LIMIT = 180;
const INSIGHT_KEYS = ["memoryId", "content", "createdAt"] as const;

interface AuditRow {
  id: number;
  ts: string;
  status: "ok" | "error";
  summary: string;
  details: Record<string, unknown> | null;
  durationMs: number | null;
}

function asNumber(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeDetails(details: Record<string, unknown> | null): SynthesisSweepDetails {
  const phaseStatus = details?.phase_status;
  const phaseErrors = details?.phase_errors;

  return {
    patterns_found: asNumber(details?.patterns_found),
    insights_created: asNumber(details?.insights_created),
    insights_updated: asNumber(details?.insights_updated),
    contradictions_flagged: asNumber(details?.contradictions_flagged),
    gaps_created: asNumber(details?.gaps_created),
    confidence_decayed: asNumber(details?.confidence_decayed),
    validation_rejected: asNumber(details?.validation_rejected),
    phase_status: typeof phaseStatus === "object" && phaseStatus != null ? phaseStatus as SynthesisSweepDetails["phase_status"] : undefined,
    phase_errors: typeof phaseErrors === "object" && phaseErrors != null ? phaseErrors as SynthesisSweepDetails["phase_errors"] : undefined,
  };
}

function withinWindow(createdAt: string, ts: string, durationMs: number | null): boolean {
  const createdMs = Date.parse(createdAt);
  const startMs = Date.parse(ts);
  if (!Number.isFinite(createdMs) || !Number.isFinite(startMs)) return false;
  const endMs = startMs + Math.max(60_000, durationMs ?? 0) + 1_500;
  return createdMs >= startMs - 1_500 && createdMs <= endMs;
}

export async function GET() {
  try {
    const target = new URL("/audit", WORKER_AUDIT_URL);
    target.searchParams.set("category", "CRON/synthesis");
    target.searchParams.set("limit", String(AUDIT_LIMIT));

    const auditRes = await fetch(target.toString(), { cache: "no-store" });
    if (!auditRes.ok) {
      return NextResponse.json(
        { error: `audit worker responded ${auditRes.status}`, runs: [] },
        { status: 502 },
      );
    }

    const auditData = await auditRes.json();
    const rows: AuditRow[] = Array.isArray(auditData.rows) ? auditData.rows : [];
    const orderedRows = [...rows].sort((left, right) => right.ts.localeCompare(left.ts));

    let createdInsights: InsightLink[] = [];
    const earliestTs = orderedRows.reduce<string | null>((earliest, row) => {
      if (!earliest) return row.ts;
      return row.ts < earliest ? row.ts : earliest;
    }, null);

    if (earliestTs) {
      const req = readBatch()
        .varAs(
          "insights",
          g().nWithLabel("Memory")
            .where(
              Predicate.and([
                Predicate.eq("tenant_id", TENANT),
                Predicate.eq("primaryType", "SEMANTIC"),
                Predicate.eq("kind", "synthetic"),
                Predicate.gte("createdAt", earliestTs),
              ]),
            )
            .valueMap([...INSIGHT_KEYS]),
        )
        .returning(["insights"]);
      const res = await runRead(req.toDynamicRequest({ queryName: "observability_synthesis_insights" }));
      createdInsights = (res.insights?.properties ?? []).map((row: any) => ({
        memoryId: String(row.memoryId),
        content: String(row.content ?? ""),
        createdAt: String(row.createdAt ?? ""),
      }));
    }

    const runs: SynthesisRun[] = orderedRows.map((row) => {
      const details = normalizeDetails(row.details);
      return {
        id: row.id,
        ts: row.ts,
        summary: row.summary,
        durationMs: row.durationMs,
        auditStatus: row.status,
        result: synthesisResult(row.status, details.phase_status),
        details,
        createdInsights: createdInsights
          .filter((insight) => withinWindow(insight.createdAt, row.ts, row.durationMs))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      };
    });

    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to load synthesis observability: ${error instanceof Error ? error.message : "Unknown error"}`,
        runs: [],
      },
      { status: 500 },
    );
  }
}
