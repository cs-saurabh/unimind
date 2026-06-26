/**
 * Worker-side audit sink: an in-memory batch buffer flushed to SQLite on a short
 * interval (or when full). This is the "queue + batch consumer" — non-blocking
 * producers, batched single-writer inserts — without standing up any infrastructure.
 *
 * startAudit() wires this as the directSink in emit.ts, so every audit() call in the
 * worker process lands here instead of the spool.
 */
import { insertBatch } from "./db.js";
import { setAuditSink } from "./emit.js";
import type { AuditRecord } from "./types.js";

const FLUSH_MS = 500;
const MAX_BATCH = 200;

let buffer: AuditRecord[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function push(rec: AuditRecord): void {
  buffer.push(rec);
  if (buffer.length >= MAX_BATCH) flushNow();
}

/** Drain the in-memory buffer into SQLite in one transaction. Never throws. */
export function flushNow(): void {
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];
  try {
    insertBatch(batch);
  } catch (e) {
    console.error("[audit] buffer insert failed:", (e as Error)?.message ?? e);
  }
}

/** Install the SQLite sink + start the periodic flusher. Idempotent. */
export function startAudit(): void {
  setAuditSink(push);
  if (!timer) {
    timer = setInterval(flushNow, FLUSH_MS);
    timer.unref?.(); // don't keep the process alive on the flusher alone
  }
}
