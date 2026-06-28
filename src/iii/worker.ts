/**
 * iii worker — the orchestration backbone for the write path (§2, §5.1).
 * Registers the queue worker functions and an idle-flush cron. Hooks enqueue
 * turn events onto the `ingest` queue (fire-and-forget, §5.2); this worker
 * salience-gates, buffers, and flushes asynchronously.
 *
 * Run: start the iii engine (`iii`), then `npm run worker` (or add as an iii worker).
 */
import { registerWorker } from "iii-sdk";
import { FileBufferStore, flushReason } from "../write/buffer.js";
import { ingestTurn } from "../write/ingest.js";
import { flushSession } from "../write/pipeline.js";
import { decaySweep, forgetSweep, expireContextual } from "../maintain/sweeps.js";
import { synthesizeSweep } from "../maintain/synthesis.js";
import { erRepairSweep } from "../maintain/erRepair.js";
import type { TurnEvent } from "../write/types.js";
import { audit } from "../audit/emit.js";
import { startAudit } from "../audit/record.js";
import { startAuditServer } from "../audit/server.js";
import { startAuditDrain } from "../audit/drain.js";

const url = process.env.III_URL ?? "ws://localhost:49134";
const bufferDir = process.env.UNIMIND_BUFFER_DIR ?? ".unimind/buffers";
const SYNTHESIS_MAX_ATTEMPTS = Math.max(1, Number(process.env.UNIMIND_SYNTHESIS_MAX_ATTEMPTS ?? 3) || 3);
const SYNTHESIS_RETRY_BASE_MS = Math.max(50, Number(process.env.UNIMIND_SYNTHESIS_RETRY_BASE_MS ?? 1000) || 1000);

// Audit infrastructure (this is the sole SQLite writer): route worker audit() calls to
// the in-memory batch buffer → SQLite, serve the dashboard read API, and drain the
// host-originated spool (~1s) so hook/MCP events appear near-real-time.
startAudit();
startAuditServer(Number(process.env.AUDIT_PORT ?? 48180));
startAuditDrain(Number(process.env.AUDIT_DRAIN_MS ?? 1000));

const iii = registerWorker(url, { workerName: "unimind" });
const store = new FileBufferStore(bufferDir);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Consumes the `ingest` queue: gate → buffer → maybe flush. (Enqueued by hooks.)
iii.registerFunction(
  "unimind::ingestTurn",
  async (event: TurnEvent) => ingestTurn(store, event),
  { description: "Salience-gate a turn, buffer it into the session window, flush on trigger." },
);

// Manual / boundary flush of a specific session.
iii.registerFunction(
  "unimind::flushSession",
  async (data: { sessionId: string }) => flushSession(store, data.sessionId, "manual"),
  { description: "Force-flush a session buffer (extract → resolve → write)." },
);

// Idle/time-cap sweep: crystallize buffers that have gone quiet (§7 flush triggers).
iii.registerFunction("unimind::sweepIdle", async () => {
  const startedAt = Date.now();
  const nowIso = new Date().toISOString();
  const buffers = await store.list();
  const flushed: string[] = [];
  try {
    for (const buf of buffers) {
      // Reuse flushReason with a synthetic time-only event to detect the time cap.
      const reason = flushReason(buf, { sessionId: buf.sessionId, role: "user", text: "", ts: nowIso });
      if (reason) {
        await flushSession(store, buf.sessionId, reason); // each flush emits its own WRITE/flush row
        flushed.push(buf.sessionId);
      }
    }
    audit({
      category: "CRON/sweep-idle", actor: "cron",
      summary: `swept ${buffers.length} buffer(s), flushed ${flushed.length}`,
      details: { swept: buffers.length, flushed }, durationMs: Date.now() - startedAt,
    });
    return { swept: buffers.length, flushed };
  } catch (err) {
    audit({
      category: "CRON/sweep-idle", actor: "cron", status: "error",
      summary: `sweep-idle failed: ${(err as Error)?.message ?? err}`,
      details: { swept: buffers.length, flushed, error: String((err as Error)?.message ?? err) },
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
});

// Fire the idle-flush sweep once a minute.
iii.registerTrigger({
  type: "cron",
  function_id: "unimind::sweepIdle",
  config: { expression: "0 * * * * * *" }, // every minute (7-field, seconds-precision)
});

// ---- Maintenance jobs (§13, step 7) ----

// Hourly: physically expire contextual TTLs.
iii.registerFunction("unimind::expireContextual", async () => {
  const startedAt = Date.now();
  try {
    const r = await expireContextual();
    audit({
      category: "CRON/expire-contextual", actor: "cron",
      summary: `hard-deleted ${r.expired} expired contextual memory(ies)`,
      details: { ...r }, durationMs: Date.now() - startedAt,
    });
    return r;
  } catch (err) {
    audit({
      category: "CRON/expire-contextual", actor: "cron", status: "error",
      summary: `expire-contextual failed: ${(err as Error)?.message ?? err}`,
      details: { error: String((err as Error)?.message ?? err) }, durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}, { description: "Drop contextual memories whose TTL has passed." });
iii.registerTrigger({ type: "cron", function_id: "unimind::expireContextual", config: { expression: "0 0 * * * * *" } });

// Daily: decay idle weights, then forget weak/stale memories (use-it-or-lose-it).
iii.registerFunction("unimind::decayAndForget", async () => {
  const startedAt = Date.now();
  let decayed = { decayed: 0 };
  try {
    decayed = await decaySweep();
    audit({
      category: "CRON/decay", actor: "cron",
      summary: `decayed ${decayed.decayed} idle memory weight(s)`,
      details: { ...decayed }, durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    audit({
      category: "CRON/decay", actor: "cron", status: "error",
      summary: `decay failed: ${(err as Error)?.message ?? err}`,
      details: { error: String((err as Error)?.message ?? err) }, durationMs: Date.now() - startedAt,
    });
    throw err;
  }
  const forgetStart = Date.now();
  try {
    const forgotten = await forgetSweep();
    audit({
      category: "CRON/forget", actor: "cron",
      summary: `soft-deleted ${forgotten.forgotten} weak/stale memory(ies)`,
      details: { ...forgotten }, durationMs: Date.now() - forgetStart,
    });
    return { ...decayed, ...forgotten };
  } catch (err) {
    audit({
      category: "CRON/forget", actor: "cron", status: "error",
      summary: `forget failed: ${(err as Error)?.message ?? err}`,
      details: { error: String((err as Error)?.message ?? err) }, durationMs: Date.now() - forgetStart,
    });
    throw err;
  }
}, { description: "Decay idle memory weights and soft-delete weak stale ones." });
iii.registerTrigger({ type: "cron", function_id: "unimind::decayAndForget", config: { expression: "0 0 4 * * * *" } }); // 04:00 daily

// Daily: synthesis orchestration (pattern -> contradiction -> gap -> confidence decay).
iii.registerFunction("unimind::synthesizeSweep", async () => {
  const startedAt = Date.now();
  const attemptErrors: string[] = [];
  const retryBackoffMs: number[] = [];

  for (let attempt = 1; attempt <= SYNTHESIS_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await synthesizeSweep();
      audit({
        category: "CRON/synthesis",
        actor: "cron",
        summary: result.summary,
        details: {
          ...(result.details as Record<string, unknown>),
          retry_attempts: attempt,
          retry_recovered: attempt > 1,
          retry_backoff_ms: retryBackoffMs,
        },
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      attemptErrors.push(message);
      if (attempt < SYNTHESIS_MAX_ATTEMPTS) {
        const backoffMs = SYNTHESIS_RETRY_BASE_MS * 2 ** (attempt - 1);
        retryBackoffMs.push(backoffMs);
        await sleep(backoffMs);
        continue;
      }

      const notified = attemptErrors.length >= 3;
      if (notified) {
        console.error("[alert] synthesis sweep exhausted retries", {
          attempts: attempt,
          errors: attemptErrors,
        });
      }
      audit({
        category: "CRON/synthesis",
        actor: "cron",
        status: "error",
        summary: `synthesis sweep failed after ${attempt} attempt(s): ${message}`,
        details: {
          error: message,
          retry_attempts: attempt,
          retry_backoff_ms: retryBackoffMs,
          attempt_errors: attemptErrors,
          notified,
          alert_code: notified ? "synthesis_retry_exhausted" : null,
        },
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
  throw new Error("synthesis sweep exited unexpectedly");
}, { description: "Run the daily memory-intelligence synthesis sweep with per-phase isolation." });
iii.registerTrigger({ type: "cron", function_id: "unimind::synthesizeSweep", config: { expression: "0 0 11 * * * *" } }); // 11:00 daily

// Daily: entity-resolution repair (merge missed duplicates).
iii.registerFunction("unimind::erRepair", async () => {
  const startedAt = Date.now();
  try {
    const r = await erRepairSweep();
    audit({
      category: "CRON/er-repair", actor: "cron",
      summary: `merged ${r.merged} duplicate entity pair(s)`,
      details: { ...r }, durationMs: Date.now() - startedAt,
    });
    return r;
  } catch (err) {
    audit({
      category: "CRON/er-repair", actor: "cron", status: "error",
      summary: `er-repair failed: ${(err as Error)?.message ?? err}`,
      details: { error: String((err as Error)?.message ?? err) }, durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}, { description: "Merge entity nodes that are really the same real-world thing." });
iii.registerTrigger({ type: "cron", function_id: "unimind::erRepair", config: { expression: "0 30 4 * * * *" } }); // 04:30 daily

console.info("unimind worker ready", { url, bufferDir });
