/**
 * Read-path end-to-end + CHECKPOINT 1 demo. Seeds memories by running the write
 * pipeline over a real transcript window, then runs the read path with a relevant
 * prompt and prints the injected header — the cheap early-warning for Risk 1
 * ("does injected memory help?"). Isolated throwaway tenant; wiped after.
 *
 *   UNIMIND_TENANT=e2etest UNIMIND_USER=e2e npx tsx src/read/e2e.ts [sessionIndex] [windowSize] "prompt"
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBatch, g, Predicate } from "@helix-db/helix-db";
import { writeWithRetry } from "../db/client.js";
import { L } from "../db/schema.js";
import { TENANT_ID } from "../config.js";
import { FileBufferStore } from "../write/buffer.js";
import { flushSession } from "../write/pipeline.js";
import { ingestTurn } from "../write/ingest.js";
import { readPath } from "./readPath.js";
import type { TurnEvent } from "../write/types.js";

async function wipe() {
  const req = writeBatch()
    .varAs("dm", g().nWithLabel(L.Memory).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .varAs("de", g().nWithLabel(L.Entity).where(Predicate.eq("tenant_id", TENANT_ID)).drop())
    .returning(["dm", "de"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "read_e2e_wipe" }));
}

async function main() {
  if (TENANT_ID === "unimind") { console.error("Set UNIMIND_TENANT=e2etest."); process.exit(1); }
  const idx = Number(process.argv[2] ?? 4);
  const windowSize = Number(process.argv[3] ?? 8);
  const prompt = process.argv[4] ?? "what was the analytics-ui backend issue and the rollup error about?";

  const sessions = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "experiments", "drift-gate", "data", "sessions.json"), "utf8"));
  const session = sessions[idx];
  console.log(`seeding from: ${session.project.slice(-40)} (${windowSize} prompts)\n`);

  await wipe();

  // --- SEED: run write pipeline over the window ---
  const store = new FileBufferStore(mkdtempSync(join(tmpdir(), "umind-read-")));
  const sid = `read-e2e-${idx}`;
  const base = Date.parse("2026-06-22T10:00:00Z");
  const prompts: string[] = session.prompts.slice(0, windowSize);
  for (let i = 0; i < prompts.length; i++) {
    const event: TurnEvent = {
      sessionId: sid, role: "user", text: prompts[i], ts: new Date(base + i * 30_000).toISOString(),
      project: session.project, boundary: i === prompts.length - 1 ? "session_end" : undefined,
    };
    await ingestTurn(store, event);
  }
  await flushSession(store, sid, "manual"); // ensure flushed

  // --- READ: run the read path with a relevant prompt ---
  console.log(`PROMPT: ${prompt}\n`);
  const res = await readPath(prompt);
  console.log("=== INJECTED HEADER (Checkpoint 1 — eyeball relevance) ===");
  console.log(res.header || "(nothing injected)");
  console.log("\n=== DEBUG ===");
  console.log("topicShifted:", res.topicShifted);
  console.log("entities validated:", res.debug.entitiesValidated.join(", ") || "—");
  console.log("counts:", JSON.stringify(res.debug.counts));

  await wipe();
  console.log("\n✓ wiped");
}

main().catch((e) => { console.error("READ E2E FAILED:", e?.message ?? e); process.exit(1); });
