/**
 * Host-side audit delivery: a synchronous, swallowed append to the spool file.
 *
 * Short-lived processes (Claude Code hooks, the MCP server) cannot fire-and-forget
 * over the network — the process can exit before an async POST flushes, losing the
 * event. A synchronous file append takes microseconds, survives process exit, and
 * never throws into the memory path. The worker drains this spool into SQLite (~1s).
 *
 * IMPORTANT: this module is fs-only on purpose — it MUST NOT import node:sqlite, so
 * the host (whatever Node version Claude Code runs) can load it unconditionally.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuditRecord } from "./types.js";

/**
 * Default mirrors the checkpoint-log convention (~/.unimind). In the worker container
 * AUDIT_SPOOL_PATH points at the bind-mounted host dir so both sides see one file.
 */
export const AUDIT_SPOOL_PATH =
  process.env.AUDIT_SPOOL_PATH ?? join(homedir(), ".unimind", "audit-spool.jsonl");

let ensured = false;

export function spoolAppend(rec: AuditRecord): void {
  if (!ensured) {
    mkdirSync(dirname(AUDIT_SPOOL_PATH), { recursive: true });
    ensured = true;
  }
  appendFileSync(AUDIT_SPOOL_PATH, JSON.stringify(rec) + "\n");
}
