/**
 * audit() — the single, context-agnostic entry point every memory operation calls.
 * Async/fire-and-forget by contract: it NEVER awaits and NEVER throws into the caller,
 * so an audit hiccup can never block or fail a memory operation.
 *
 * Routing:
 *   - In the worker, record.ts calls setAuditSink(), so audit() pushes to the in-memory
 *     batch buffer (→ SQLite). True fire-and-forget.
 *   - Everywhere else (host hooks, MCP, the one-shot bootstrap process) no sink is set,
 *     so audit() does a synchronous spool append. The worker drains it.
 *
 * This module imports only client.ts (fs-only) + config — never node:sqlite. The sqlite
 * sink is injected at runtime by the worker, so the host never loads sqlite.
 */
import { TENANT_ID, USER_ID } from "../config.js";
import { spoolAppend } from "./client.js";
import type { AuditInput, AuditRecord } from "./types.js";

type Sink = (rec: AuditRecord) => void;

let directSink: Sink | null = null;

/** Called by the worker (record.ts) to route audit writes straight to SQLite. */
export function setAuditSink(sink: Sink): void {
  directSink = sink;
}

export function audit(input: AuditInput): void {
  try {
    const rec: AuditRecord = {
      ts: new Date().toISOString(),
      category: input.category,
      actor: input.actor,
      status: input.status ?? "ok",
      sessionId: input.sessionId ?? null,
      tenantId: TENANT_ID,
      userId: USER_ID,
      summary: input.summary,
      details: input.details ?? null,
      durationMs: input.durationMs ?? null,
    };
    if (directSink) directSink(rec);
    else spoolAppend(rec);
  } catch {
    /* audit must never throw into the memory path */
  }
}
