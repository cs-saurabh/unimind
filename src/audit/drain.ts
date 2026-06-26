/**
 * Spool drainer (worker-only). Moves host-originated audit events from the append-only
 * spool file into SQLite. Runs every ~1s so host events (inject/recall/capture/remember)
 * appear near-real-time.
 *
 * Rotation by atomic rename: the spool is renamed aside before reading, so any concurrent
 * host append lands in a fresh spool file and is picked up next tick — no offset
 * bookkeeping, no lost-line race. The draining file is deleted only AFTER its records are
 * committed to SQLite, so a crash mid-drain re-processes it (at-least-once, never lost).
 */
import { renameSync, existsSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { insertBatch } from "./db.js";
import { AUDIT_SPOOL_PATH } from "./client.js";
import type { AuditRecord } from "./types.js";

const DRAINING_PATH = `${AUDIT_SPOOL_PATH}.draining`;

function processDrainingFile(): void {
  const content = readFileSync(DRAINING_PATH, "utf8");
  const recs: AuditRecord[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      recs.push(JSON.parse(t) as AuditRecord);
    } catch {
      /* skip a corrupt/torn line rather than stall the whole drain */
    }
  }
  if (recs.length) insertBatch(recs); // commit BEFORE unlink → durable
  unlinkSync(DRAINING_PATH);
}

function drainOnce(): void {
  try {
    // Recover a drain that crashed mid-flight before rotating the live spool.
    if (existsSync(DRAINING_PATH)) processDrainingFile();
    if (!existsSync(AUDIT_SPOOL_PATH) || statSync(AUDIT_SPOOL_PATH).size === 0) return;
    renameSync(AUDIT_SPOOL_PATH, DRAINING_PATH);
    processDrainingFile();
  } catch (e) {
    console.error("[audit] drain failed:", (e as Error)?.message ?? e);
  }
}

export function startAuditDrain(intervalMs = 1000): void {
  drainOnce(); // catch up immediately on startup (incl. the bootstrap process's row)
  const t = setInterval(drainOnce, intervalMs);
  t.unref?.();
}
