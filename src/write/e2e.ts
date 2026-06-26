/**
 * End-to-end write-path run against a REAL transcript window. Feeds a session's
 * prompts through ingestTurn (salience → buffer), forces a flush, then queries
 * Helix back to confirm memories + entities landed. Runs in an isolated throwaway
 * tenant (UNIMIND_TENANT) so it can be wiped. Doubles as extraction-precision
 * eyeballing (validation step 3) — inspect the printed memories for relevance.
 *
 *   UNIMIND_TENANT=e2etest UNIMIND_USER=e2e npx tsx src/write/e2e.ts [sessionIndex] [windowSize]
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBatch, writeBatch, g, Predicate, PropertyProjection } from "@helix-db/helix-db";
import { helix, writeWithRetry } from "../db/client.js";
import { L } from "../db/schema.js";
import { TENANT_ID } from "../config.js";
import { FileBufferStore } from "./buffer.js";
import { ingestTurn } from "./ingest.js";
import type { TurnEvent } from "./types.js";

async function dumpTenant() {
  const req = readBatch()
    .varAs("mems", g().nWithLabel(L.Memory).where(Predicate.eq("tenant_id", TENANT_ID))
      .project([PropertyProjection.new("primaryType"), PropertyProjection.new("content"), PropertyProjection.new("tags")]))
    .varAs("ents", g().nWithLabel(L.Entity).where(Predicate.eq("tenant_id", TENANT_ID))
      .project([PropertyProjection.new("name"), PropertyProjection.new("entityType"), PropertyProjection.new("aliases")]))
    .returning(["mems", "ents"]);
  return helix.query<any>().dynamic(req.toDynamicRequest({ queryName: "e2e_dump" })).send();
}

async function wipeTenant() {
  const req = writeBatch()
    .varAs("dm", g().nWithLabel(L.Memory).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .varAs("de", g().nWithLabel(L.Entity).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .returning(["dm", "de"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "e2e_wipe" }));
}

async function main() {
  if (TENANT_ID === "unimind") {
    console.error("Refusing to run e2e against the default tenant. Set UNIMIND_TENANT=e2etest.");
    process.exit(1);
  }
  const idx = Number(process.argv[2] ?? 1);
  const windowSize = Number(process.argv[3] ?? 8);
  const sessions = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "experiments", "drift-gate", "data", "sessions.json"), "utf8"));
  const session = sessions[idx];
  if (!session) { console.error(`no session at index ${idx}`); process.exit(1); }
  const prompts: string[] = session.prompts.slice(0, windowSize);
  console.log(`session: ${session.project.slice(-40)}  window: ${prompts.length} prompts\n`);

  await wipeTenant(); // clean slate in the throwaway tenant

  const store = new FileBufferStore(mkdtempSync(join(tmpdir(), "umind-e2e-")));
  const sid = `e2e-${idx}`;
  const base = Date.parse("2026-06-22T10:00:00Z");
  let buffered = 0;
  for (let i = 0; i < prompts.length; i++) {
    const event: TurnEvent = {
      sessionId: sid, role: "user", text: prompts[i],
      ts: new Date(base + i * 30_000).toISOString(), project: session.project,
      boundary: i === prompts.length - 1 ? "session_end" : undefined, // force final flush
    };
    const r = await ingestTurn(store, event);
    if (r.buffered) buffered++;
    if (r.flushed) {
      console.log(`FLUSH (${r.flushed.reason}): ${r.flushed.memories} memories, ` +
        `${r.flushed.entitiesCreated} entities created, ${r.flushed.entitiesLinked} linked`);
    }
  }
  console.log(`\nbuffered ${buffered}/${prompts.length} turns past the salience gate\n`);

  const dump: any = await dumpTenant();
  console.log("=== MEMORIES (inspect for relevance) ===");
  for (const m of dump.mems?.properties ?? []) {
    console.log(`  [${m.primaryType}] ${m.content}${m.tags?.length ? `  {${m.tags.join(",")}}` : ""}`);
  }
  console.log("\n=== ENTITIES (inspect for over/under-merge) ===");
  for (const e of dump.ents?.properties ?? []) {
    console.log(`  (${e.entityType}) ${e.name}  aliases=[${(e.aliases ?? []).join(", ")}]`);
  }

  await wipeTenant();
  console.log("\n✓ e2e tenant wiped");
}

main().catch((e) => { console.error("E2E FAILED:", e?.message ?? e); process.exit(1); });
