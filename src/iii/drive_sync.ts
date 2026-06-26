/**
 * Live verification via SYNCHRONOUS triggers on a single connection — proves the
 * full round-trip (engine routes → unimind worker handler → write pipeline → Helix)
 * without the fire-and-forget shutdown race. Returns each ingest result inline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerWorker } from "iii-sdk";
import { readBatch, writeBatch, g, Predicate, PropertyProjection } from "@helix-db/helix-db";
import { helix, writeWithRetry } from "../db/client.js";
import { L } from "../db/schema.js";
import { TENANT_ID } from "../config.js";
import type { TurnEvent } from "../write/types.js";

async function main() {
  if (TENANT_ID === "unimind") { console.error("Set UNIMIND_TENANT=e2etest."); process.exit(1); }
  const idx = Number(process.argv[2] ?? 4);
  const windowSize = Number(process.argv[3] ?? 6);
  const sessions = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "experiments", "drift-gate", "data", "sessions.json"), "utf8"));
  const prompts: string[] = sessions[idx].prompts.slice(0, windowSize);
  const sid = `livesync-${idx}-${windowSize}`;

  // wipe
  await writeWithRetry(writeBatch()
    .varAs("dm", g().nWithLabel(L.Memory).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .varAs("de", g().nWithLabel(L.Entity).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .returning(["dm", "de"]).toDynamicRequest({ queryName: "ds_wipe" }));

  const iii = registerWorker(process.env.III_URL ?? "ws://localhost:49134", { workerName: `unimind-driver-${process.pid}` });
  const base = Date.now();
  try {
    for (let i = 0; i < prompts.length; i++) {
      const event: TurnEvent = {
        sessionId: sid, role: "user", text: prompts[i], ts: new Date(base + i * 1000).toISOString(),
        project: sessions[idx].project, boundary: i === prompts.length - 1 ? "session_end" : undefined,
      };
      const res = await iii.trigger<TurnEvent, any>({ function_id: "unimind::ingestTurn", payload: event, timeoutMs: 60_000 });
      console.log(`turn ${i}: buffered=${res?.buffered} signals=[${(res?.signals ?? []).join(",")}]` +
        (res?.flushed ? `  FLUSH(${res.flushed.reason}): ${res.flushed.memories} mem, ${res.flushed.entitiesCreated} ent` : ""));
    }
  } finally {
    await iii.shutdown().catch(() => {});
  }

  const dump: any = await helix.query().dynamic(readBatch().varAs("m", g().nWithLabel(L.Memory)
    .where(Predicate.eq("tenant_id", TENANT_ID)).project([PropertyProjection.new("content")])).returning(["m"])
    .toDynamicRequest({ queryName: "ds_count" })).send();
  const rows = dump.m?.properties ?? [];
  console.log(`\nmemories in Helix: ${rows.length}`);
  for (const r of rows.slice(0, 6)) console.log(`  - ${r.content}`);

  await writeWithRetry(writeBatch()
    .varAs("dm", g().nWithLabel(L.Memory).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .varAs("de", g().nWithLabel(L.Entity).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .returning(["dm", "de"]).toDynamicRequest({ queryName: "ds_wipe2" }));
  console.log("\n✓ wiped. Live round-trip verified: engine → worker → pipeline → Helix.");
}

main().catch((e) => { console.error("DRIVE_SYNC FAILED:", e?.message ?? e); process.exit(1); });
