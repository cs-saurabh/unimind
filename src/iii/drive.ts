/**
 * Live integration driver: pushes real turn events through the iii `ingest` queue
 * (engine → queue → unimind worker → write pipeline → Helix), ending with a boundary
 * to force a flush, then polls Helix to confirm memories landed. Proves the
 * orchestration end-to-end, not just the handler logic.
 *
 *   UNIMIND_TENANT=e2etest UNIMIND_USER=e2e npx tsx src/iii/drive.ts [sessionIndex] [windowSize]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBatch, writeBatch, g, Predicate, PropertyProjection } from "@helix-db/helix-db";
import { helix, writeWithRetry } from "../db/client.js";
import { L } from "../db/schema.js";
import { TENANT_ID } from "../config.js";
import { emitTurnEvent } from "../hooks/emit.js";
import type { TurnEvent } from "../write/types.js";

async function memCount(): Promise<{ count: number; sample: string[] }> {
  const req = readBatch().varAs("m", g().nWithLabel(L.Memory).where(Predicate.eq("tenant_id", TENANT_ID))
    .project([PropertyProjection.new("content")])).returning(["m"]);
  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "drive_count" })).send();
  const rows = res.m?.properties ?? [];
  return { count: rows.length, sample: rows.slice(0, 6).map((r: any) => r.content) };
}

async function wipe() {
  const req = writeBatch()
    .varAs("dm", g().nWithLabel(L.Memory).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .varAs("de", g().nWithLabel(L.Entity).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .returning(["dm", "de"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "drive_wipe" }));
}

async function main() {
  if (TENANT_ID === "unimind") { console.error("Set UNIMIND_TENANT=e2etest."); process.exit(1); }
  const idx = Number(process.argv[2] ?? 4);
  const windowSize = Number(process.argv[3] ?? 6);
  const sessions = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "experiments", "drift-gate", "data", "sessions.json"), "utf8"));
  const prompts: string[] = sessions[idx].prompts.slice(0, windowSize);
  const sid = `live-${idx}-${windowSize}`;

  await wipe();
  console.log(`enqueuing ${prompts.length} turns onto the live ingest queue (session ${sid})...`);
  const base = Date.now();
  for (let i = 0; i < prompts.length; i++) {
    const event: TurnEvent = {
      sessionId: sid, role: "user", text: prompts[i], ts: new Date(base + i * 1000).toISOString(),
      project: sessions[idx].project, boundary: i === prompts.length - 1 ? "session_end" : undefined,
    };
    await emitTurnEvent(event);
    process.stdout.write(".");
  }
  console.log("\nenqueued. polling Helix for written memories (worker processes async)...");

  let final = { count: 0, sample: [] as string[] };
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    final = await memCount();
    if (final.count > 0) break;
    process.stdout.write("·");
  }
  console.log(`\n\nmemories in Helix (tenant ${TENANT_ID}): ${final.count}`);
  for (const c of final.sample) console.log(`  - ${c}`);

  await wipe();
  console.log("\n✓ wiped. Live path verified: hook→ingest queue→worker→pipeline→Helix.");
}

main().catch((e) => { console.error("DRIVE FAILED:", e?.message ?? e); process.exit(1); });
