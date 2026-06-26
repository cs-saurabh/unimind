/**
 * Fire-and-forget event emitter for Claude Code hooks (§5.2). Connects to the iii
 * engine, enqueues the turn event onto the `ingest` queue, and returns. Never blocks
 * the user: capture is async; the heavy pipeline runs in the worker.
 */
import { registerWorker, TriggerAction } from "iii-sdk";
import type { TurnEvent } from "../write/types.js";

export async function emitTurnEvent(
  event: TurnEvent,
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<void> {
  const url = opts.url ?? process.env.III_URL ?? "ws://localhost:49134";
  const iii = registerWorker(url, { workerName: `unimind-hook-${process.pid}` });
  try {
    // Fire-and-forget (§5.2): the hook never waits on capture; the worker runs async.
    // Upgrade path: swap Void() for Enqueue({queue:"ingest"}) once the durable queue
    // topic is declared in config.yaml (gains retry/concurrency/DLQ).
    await iii.trigger({
      function_id: "unimind::ingestTurn",
      payload: event,
      action: TriggerAction.Void(),
    });
    // Void resolves once locally queued; let the WS flush the frame before we close,
    // otherwise shutdown() races the send and the message is dropped. (The durable
    // named-queue upgrade removes this race entirely.)
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    await iii.shutdown().catch(() => {});
  }
}
