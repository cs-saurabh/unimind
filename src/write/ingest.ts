/**
 * Ingest handler (§7 write steps 2-3): salience gate → buffer → flush-trigger check.
 * This is the body of the iii `ingestTurn` queue worker (see src/iii/worker.ts).
 * Fire-and-forget on the write path (§5.2): the hook returns immediately; this runs async.
 */
import type { BufferStore, FlushConfig } from "./buffer.js";
import { flushReason, DEFAULT_FLUSH } from "./buffer.js";
import { flushSession, type FlushSummary } from "./pipeline.js";
import { salienceGate } from "./salience.js";
import type { TurnEvent } from "./types.js";

export interface IngestResult {
  buffered: boolean;
  signals: string[];
  flushed?: FlushSummary;
}

export async function ingestTurn(
  store: BufferStore,
  event: TurnEvent,
  cfg: FlushConfig = DEFAULT_FLUSH,
): Promise<IngestResult> {
  const tag = `[ingestTurn] session=${event.sessionId} project=${event.project ?? "-"}`;
  console.info(
    `${tag} ← turn role=${event.role}${event.toolName ? ` tool=${event.toolName}` : ""} ` +
      `len=${event.text?.length ?? 0} ts=${event.ts}`,
  );

  const verdict = salienceGate(event);
  console.info(
    `${tag} salience ${verdict.pass ? "PASS" : "DROP"}` +
      `${verdict.signals.length ? ` signals=[${verdict.signals.join(",")}]` : ""}`,
  );

  let buf = await store.get(event.sessionId);
  if (verdict.pass) {
    buf = await store.append(
      event.sessionId,
      { role: event.role, text: event.text, ts: event.ts, toolName: event.toolName, signals: verdict.signals },
      { project: event.project, ts: event.ts },
    );
    console.info(`${tag} buffered → window size=${buf.turns.length}`);
  } else {
    console.info(`${tag} not buffered (salience drop); window size=${buf?.turns.length ?? 0}`);
  }

  const reason = buf ? flushReason(buf, event, cfg) : null;
  if (reason) {
    console.info(`${tag} flush TRIGGERED reason=${reason} — extracting…`);
    const flushed = await flushSession(store, event.sessionId, reason);
    console.info(
      `${tag} flush DONE reason=${reason} ` +
        `memories=${flushed.memories} reinforced=${flushed.reinforced} superseded=${flushed.superseded} ` +
        `entitiesCreated=${flushed.entitiesCreated} entitiesLinked=${flushed.entitiesLinked}`,
    );
    return { buffered: verdict.pass, signals: verdict.signals, flushed };
  }

  console.info(`${tag} no flush (window held); done`);
  return { buffered: verdict.pass, signals: verdict.signals };
}
