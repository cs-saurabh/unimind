/**
 * Audit log types. Every memory operation in unimind — reads, writes, and all
 * maintenance crons — is recorded as one row per logical operation (see AUDIT_LOG_PLAN.md).
 * Sub-step detail, affected IDs and deltas live in the `details` JSON blob.
 */

/** Who performed the action. */
export type AuditActor = "hook" | "skill" | "cron" | "worker";

/** Self-explanatory operation category. The taxonomy IS the audit story. */
export type AuditCategory =
  | "READ/inject" // R1 — UserPromptSubmit auto-inject (hook)
  | "READ/recall" // R2 — recall MCP tool (skill)
  | "WRITE/capture" // W1 — turn event enqueued by a hook
  | "WRITE/flush" // W1/W3 — buffer flush & persist (worker)
  | "WRITE/remember" // W2 — remember MCP tool (skill)
  | "CRON/sweep-idle" // M1
  | "CRON/synthesis" // memory intelligence synthesis sweep
  | "CRON/decay" // M2
  | "CRON/forget" // M3
  | "CRON/expire-contextual" // M4
  | "CRON/er-repair" // M5
  | "SYSTEM/bootstrap"; // index bootstrap on worker start

/** What a caller passes to audit(). ts/tenant/user are filled in by emit(). */
export interface AuditInput {
  category: AuditCategory;
  actor: AuditActor;
  status?: "ok" | "error";
  sessionId?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
  durationMs?: number | null;
}

/** A fully-formed record ready for the spool or the DB. */
export interface AuditRecord {
  ts: string; // RFC3339 UTC
  category: AuditCategory;
  actor: AuditActor;
  status: "ok" | "error";
  sessionId: string | null;
  tenantId: string;
  userId: string;
  summary: string;
  details: Record<string, unknown> | null;
  durationMs: number | null;
}

/** A row read back from the DB (adds the autoincrement id; details parsed). */
export interface AuditRow extends AuditRecord {
  id: number;
}
