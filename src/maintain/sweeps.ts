/**
 * Background maintenance sweeps (§13). Run on a schedule by the iii worker (cron).
 * Implements the use-it-or-lose-it lifecycle (§5.11): unused memories decay, weak
 * stale ones are forgotten, expired contextual state is physically removed.
 */
import { writeBatch, readBatch, g, Predicate, PropertyInput, Expr, PropertyProjection } from "@helix-db/helix-db";
import { helix, writeWithRetry } from "../db/client.js";
import { L } from "../db/schema.js";
import { TENANT_ID } from "../config.js";

const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function countWhere(pred: any): Promise<number> {
  const req = readBatch().varAs("m", g().nWithLabel(L.Memory).where(pred).project([PropertyProjection.new("memoryId")])).returning(["m"]);
  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "sweep_count" })).send();
  return (res.m?.properties ?? []).length;
}

/** Decay: multiply weight by `factor` for current memories idle longer than `idleDays`. */
export async function decaySweep(idleDays = 7, factor = 0.9): Promise<{ decayed: number }> {
  const cutoff = daysAgoIso(idleDays);
  const pred = Predicate.and([
    Predicate.eq("tenant_id", TENANT_ID), Predicate.eq("isLatest", true), Predicate.isNull("deletedAt"),
    Predicate.lt("lastAccessedAt", cutoff),
  ]);
  const decayed = await countWhere(pred);
  if (decayed) {
    const req = writeBatch().varAs("m", g().nWithLabel(L.Memory).where(pred)
      .setProperty("weight", Expr.prop("weight").mul(Expr.val(factor)))).returning(["m"]);
    await writeWithRetry(req.toDynamicRequest({ queryName: "decay_sweep" }));
  }
  return { decayed };
}

/**
 * Forget: soft-delete weak, stale, rarely-used memories (use-it-or-lose-it). Never
 * touches PROCEDURAL (evergreen) or GOAL (lifecycle-managed) — §4 decay rules.
 */
export async function forgetSweep(minWeight = 0.25, idleDays = 45): Promise<{ forgotten: number }> {
  const cutoff = daysAgoIso(idleDays);
  const pred = Predicate.and([
    Predicate.eq("tenant_id", TENANT_ID), Predicate.eq("isLatest", true), Predicate.isNull("deletedAt"),
    Predicate.lt("weight", minWeight), Predicate.lt("lastAccessedAt", cutoff),
    Predicate.neq("primaryType", "PROCEDURAL"), Predicate.neq("primaryType", "GOAL"),
  ]);
  const forgotten = await countWhere(pred);
  if (forgotten) {
    const req = writeBatch().varAs("m", g().nWithLabel(L.Memory).where(pred)
      .setProperty("deletedAt", PropertyInput.value(new Date().toISOString()))).returning(["m"]);
    await writeWithRetry(req.toDynamicRequest({ queryName: "forget_sweep" }));
  }
  return { forgotten };
}

/** Expiry: physically drop CONTEXTUAL memories whose TTL has passed (§4 — only hard-deleted type). */
export async function expireContextual(): Promise<{ expired: number }> {
  const now = new Date().toISOString();
  const pred = Predicate.and([
    Predicate.eq("tenant_id", TENANT_ID), Predicate.eq("primaryType", "CONTEXTUAL"),
    Predicate.lt("expiresAt", now),
  ]);
  const expired = await countWhere(pred);
  if (expired) {
    const req = writeBatch().varAs("m", g().nWithLabel(L.Memory).where(pred).drop()).returning(["m"]);
    await writeWithRetry(req.toDynamicRequest({ queryName: "expire_contextual" }));
  }
  return { expired };
}
