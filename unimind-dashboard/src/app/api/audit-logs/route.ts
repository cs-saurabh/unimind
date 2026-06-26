// Audit log proxy: forwards to the worker's audit read API (sole owner of audit.db).
// Keeps the dashboard a dependency-free HTTP client — no sqlite, no file mounts.
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const WORKER_AUDIT_URL = process.env.WORKER_AUDIT_URL || "http://localhost:48180";

const PASS_THROUGH = ["limit", "offset", "category", "actor", "status", "since", "q"];

export async function GET(request: NextRequest) {
  try {
    const src = new URL(request.url);
    const target = new URL("/audit", WORKER_AUDIT_URL);
    for (const key of PASS_THROUGH) {
      const v = src.searchParams.get(key);
      if (v != null && v !== "") target.searchParams.set(key, v);
    }

    const res = await fetch(target.toString(), { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `audit worker responded ${res.status}`, rows: [], total: 0 },
        { status: 502 },
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to reach audit worker: ${error instanceof Error ? error.message : "Unknown error"}`,
        rows: [],
        total: 0,
      },
      { status: 502 },
    );
  }
}
