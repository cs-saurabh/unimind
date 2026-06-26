/**
 * SQLite access for the audit log (worker-only — uses Node 24's built-in node:sqlite).
 * The worker is the SOLE process that ever opens audit.db; the dashboard reads through
 * the worker's HTTP endpoint, so there is no cross-process locking to worry about.
 *
 * Do NOT import this from host code (hooks/MCP) — it would pull node:sqlite into a
 * runtime that may not support it. Host code uses client.ts (spool) instead.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuditRecord, AuditRow } from "./types.js";

const DB_PATH = process.env.AUDIT_DB_PATH ?? join(homedir(), ".unimind", "audit.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      category    TEXT    NOT NULL,
      actor       TEXT    NOT NULL,
      status      TEXT    NOT NULL,
      session_id  TEXT,
      tenant_id   TEXT    NOT NULL,
      user_id     TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      details     TEXT,
      duration_ms INTEGER
    );
  `);
  d.exec("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category);");
  d.exec("CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_log(tenant_id, ts);");
  db = d;
  return db;
}

const INSERT_SQL = `
  INSERT INTO audit_log (ts, category, actor, status, session_id, tenant_id, user_id, summary, details, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Insert a batch of records in a single transaction. Durable on return. */
export function insertBatch(recs: AuditRecord[]): void {
  if (!recs.length) return;
  const d = getDb();
  const stmt = d.prepare(INSERT_SQL);
  d.exec("BEGIN");
  try {
    for (const r of recs) {
      stmt.run(
        r.ts,
        r.category,
        r.actor,
        r.status,
        r.sessionId,
        r.tenantId,
        r.userId,
        r.summary,
        r.details ? JSON.stringify(r.details) : null,
        r.durationMs,
      );
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export interface QueryOpts {
  limit: number;
  offset: number;
  category?: string;
  actor?: string;
  status?: string;
  since?: string; // ISO ts lower bound (inclusive)
  q?: string; // substring match on summary/details
}

function mapRow(r: any): AuditRow {
  return {
    id: r.id,
    ts: r.ts,
    category: r.category,
    actor: r.actor,
    status: r.status,
    sessionId: r.session_id ?? null,
    tenantId: r.tenant_id,
    userId: r.user_id,
    summary: r.summary,
    details: r.details ? safeParse(r.details) : null,
    durationMs: r.duration_ms ?? null,
  };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

/** Paginated, filtered read for the dashboard. Newest first. */
export function queryLogs(opts: QueryOpts): { rows: AuditRow[]; total: number } {
  const d = getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.category) {
    where.push("category = ?");
    params.push(opts.category);
  }
  if (opts.actor) {
    where.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.since) {
    where.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.q) {
    where.push("(summary LIKE ? OR details LIKE ?)");
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (d.prepare(`SELECT COUNT(*) AS c FROM audit_log ${wsql}`).get(...params) as any).c as number;
  const rows = d
    .prepare(`SELECT * FROM audit_log ${wsql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset) as any[];

  return { rows: rows.map(mapRow), total };
}

/** Distinct categories/actors present — used to populate dashboard filters. */
export function distinctFacets(): { categories: string[]; actors: string[] } {
  const d = getDb();
  const categories = (d.prepare("SELECT DISTINCT category FROM audit_log ORDER BY category").all() as any[]).map(
    (r) => r.category,
  );
  const actors = (d.prepare("SELECT DISTINCT actor FROM audit_log ORDER BY actor").all() as any[]).map((r) => r.actor);
  return { categories, actors };
}
