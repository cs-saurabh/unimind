import { NextResponse } from "next/server";
import { g, Predicate, readBatch } from "@helix-db/helix-db";

import { TENANT, runRead } from "@/lib/helix";

export const dynamic = "force-dynamic";

const WORKER_AUDIT_URL = process.env.WORKER_AUDIT_URL || "http://localhost:48180";
const MONITORING_WINDOW_DAYS = 30;

type Severity = "warning" | "critical";

interface AuditRow {
  id: number;
  ts: string;
  status: "ok" | "error";
  summary: string;
  details: Record<string, unknown> | null;
  durationMs: number | null;
}

interface GapRow {
  memoryId: string;
  createdAt: string;
  deletedAt: string | null;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function asNumber(value: unknown, fallback = 0): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function localDateKey(ts: string): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDateRange(days: number): string[] {
  const out: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const key = localDateKey(new Date(Date.now() - offset * 86_400_000).toISOString());
    out.push(key);
  }
  return out;
}

async function fetchAuditRows(category: string, limit: number): Promise<AuditRow[]> {
  const target = new URL("/audit", WORKER_AUDIT_URL);
  target.searchParams.set("category", category);
  target.searchParams.set("limit", String(limit));
  target.searchParams.set("since", daysAgoIso(MONITORING_WINDOW_DAYS));

  const res = await fetch(target.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`audit worker responded ${res.status} for ${category}`);
  }
  const data = await res.json();
  return Array.isArray(data.rows) ? data.rows : [];
}

function summarizeLatency(rows: AuditRow[]) {
  const durations = rows
    .map((row) => row.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    sampleSize: durations.length,
  };
}

function summarizeReadRows(rows: AuditRow[], countKey: string) {
  const sampleSize = rows.length;
  const hits = rows.filter((row) => asNumber(row.details?.[countKey]) > 0).length;
  const utilizations = rows
    .map((row) => row.details?.token_budget_utilization)
    .map((value) => asNumber(value, NaN))
    .filter((value) => Number.isFinite(value));
  const backstopTrips = rows.filter((row) => asBoolean(row.details?.memory_backstop_tripped)).length;
  const naiveFallbacks = rows.filter((row) => asBoolean(row.details?.naive_fallback)).length;

  return {
    latencyMs: summarizeLatency(rows),
    hitRate: sampleSize > 0 ? hits / sampleSize : 0,
    averageBudgetUtilization: utilizations.length > 0
      ? utilizations.reduce((sum, value) => sum + value, 0) / utilizations.length
      : 0,
    utilizationP95: percentile(utilizations, 95),
    backstopTripRate: sampleSize > 0 ? backstopTrips / sampleSize : 0,
    naiveFallbackRate: sampleSize > 0 ? naiveFallbacks / sampleSize : 0,
    sampleSize,
  };
}

function buildSynthesisDaily(rows: AuditRow[]) {
  const byDate = new Map<string, {
    date: string;
    insightsCreated: number;
    insightsUpdated: number;
    contradictionsFlagged: number;
    gapsCreated: number;
    confidenceDecayed: number;
    validationRejected: number;
    runs: number;
  }>();

  for (const key of buildDateRange(7)) {
    byDate.set(key, {
      date: key,
      insightsCreated: 0,
      insightsUpdated: 0,
      contradictionsFlagged: 0,
      gapsCreated: 0,
      confidenceDecayed: 0,
      validationRejected: 0,
      runs: 0,
    });
  }

  for (const row of rows) {
    const key = localDateKey(row.ts);
    const bucket = byDate.get(key);
    if (!bucket) continue;
    bucket.insightsCreated += asNumber(row.details?.insights_created);
    bucket.insightsUpdated += asNumber(row.details?.insights_updated);
    bucket.contradictionsFlagged += asNumber(row.details?.contradictions_flagged);
    bucket.gapsCreated += asNumber(row.details?.gaps_created);
    bucket.confidenceDecayed += asNumber(row.details?.confidence_decayed);
    bucket.validationRejected += asNumber(row.details?.validation_rejected);
    bucket.runs += 1;
  }

  return [...byDate.values()];
}

function buildAlerts(synthesisRows: AuditRow[]) {
  const alerts: Array<{ code: string; severity: Severity; title: string; detail: string; ts: string | null }> = [];
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const todayKey = localDateKey(now.toISOString());
  const todayRun = synthesisRows.find((row) => localDateKey(row.ts) === todayKey);

  if (!todayRun && currentMinutes >= 11 * 60 + 30) {
    alerts.push({
      code: "synthesis-overrun",
      severity: "critical",
      title: "Synthesis overrun",
      detail: "No CRON/synthesis row has landed by 11:30 today.",
      ts: null,
    });
  }

  const overFlag = synthesisRows.find((row) => asNumber(row.details?.contradictions_flagged) > 50);
  if (overFlag) {
    alerts.push({
      code: "contradiction-overflagging",
      severity: "critical",
      title: "Contradiction over-flagging",
      detail: `${asNumber(overFlag.details?.contradictions_flagged)} contradictions were flagged in a single sweep.`,
      ts: overFlag.ts,
    });
  }

  const latest = synthesisRows[0];
  if (latest) {
    const previous = synthesisRows.slice(1, 8).map((row) => asNumber(row.details?.validation_rejected));
    const previousAverage = previous.length > 0
      ? previous.reduce((sum, value) => sum + value, 0) / previous.length
      : 0;
    const latestRejected = asNumber(latest.details?.validation_rejected);
    if (latestRejected >= Math.max(5, Math.ceil(previousAverage * 2))) {
      alerts.push({
        code: "validation-rejected-spike",
        severity: "warning",
        title: "Validation rejections spiked",
        detail: `Latest sweep rejected ${latestRejected} candidate memories (previous 7-run avg ${previousAverage.toFixed(1)}).`,
        ts: latest.ts,
      });
    }

    if ((latest.durationMs ?? 0) > 300_000) {
      alerts.push({
        code: "synthesis-slow",
        severity: "warning",
        title: "Synthesis exceeded 5 minutes",
        detail: `Latest synthesis run took ${Math.round((latest.durationMs ?? 0) / 1000)} seconds.`,
        ts: latest.ts,
      });
    }
  }

  return alerts;
}

async function fetchGapRows(): Promise<GapRow[]> {
  const req = readBatch()
    .varAs(
      "gaps",
      g().nWithLabel("Memory")
        .where(
          Predicate.and([
            Predicate.eq("tenant_id", TENANT),
            Predicate.eq("primaryType", "CONTEXTUAL"),
            Predicate.eq("kind", "knowledge_gap"),
            Predicate.eq("isLatest", true),
            Predicate.isNull("validTo"),
          ]),
        )
        .valueMap(["memoryId", "createdAt", "deletedAt"]),
    )
    .returning(["gaps"]);
  const res = await runRead(req.toDynamicRequest({ queryName: "observability_monitoring_gaps" }));
  return (res.gaps?.properties ?? []).map((row: any) => ({
    memoryId: String(row.memoryId),
    createdAt: String(row.createdAt ?? ""),
    deletedAt: row.deletedAt == null ? null : String(row.deletedAt),
  }));
}

function summarizeGapRows(rows: GapRow[]) {
  const keys = buildDateRange(7);
  const buckets = new Map(keys.map((key) => [key, { date: key, opened: 0, closed: 0 }]));

  for (const row of rows) {
    const openedKey = localDateKey(row.createdAt);
    if (buckets.has(openedKey)) buckets.get(openedKey)!.opened += 1;
    if (row.deletedAt) {
      const closedKey = localDateKey(row.deletedAt);
      if (buckets.has(closedKey)) buckets.get(closedKey)!.closed += 1;
    }
  }

  const open = rows.filter((row) => !row.deletedAt).length;
  const closed = rows.filter((row) => Boolean(row.deletedAt)).length;
  const closedLast7d = [...buckets.values()].reduce((sum, bucket) => sum + bucket.closed, 0);

  return {
    total: rows.length,
    open,
    closed,
    closedLast7d,
    daily: [...buckets.values()],
  };
}

export async function GET() {
  try {
    const [synthesisRows, injectRows, recallRows, gapRows] = await Promise.all([
      fetchAuditRows("CRON/synthesis", 90),
      fetchAuditRows("READ/inject", 500),
      fetchAuditRows("READ/recall", 500),
      fetchGapRows(),
    ]);

    const orderedSynthesis = [...synthesisRows].sort((left, right) => right.ts.localeCompare(left.ts));
    const injectSummary = summarizeReadRows(injectRows, "injected_count");
    const recallSummary = summarizeReadRows(recallRows, "returned");
    const gapSummary = summarizeGapRows(gapRows);

    return NextResponse.json({
      alerts: buildAlerts(orderedSynthesis),
      synthesis: {
        latestRunAt: orderedSynthesis[0]?.ts ?? null,
        latestDurationMs: orderedSynthesis[0]?.durationMs ?? null,
        latestStatus: orderedSynthesis[0]?.status ?? null,
        daily: buildSynthesisDaily(orderedSynthesis),
      },
      readPipeline: {
        inject: injectSummary,
        recall: recallSummary,
      },
      gaps: gapSummary,
      targets: {
        synthesisMs: 300_000,
        recallMs: 100,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to load monitoring summary: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      { status: 500 },
    );
  }
}
