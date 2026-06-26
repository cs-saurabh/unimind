/**
 * Entity-resolution repair (§13, §5.8). The write path biases UNDER-merge — a wrong
 * merge is near-impossible to undo, a missed one is recoverable here. This job finds
 * two entity nodes that are really one (high embedding similarity + shared surface
 * form) and merges the loser into the survivor: union aliases, re-point MENTIONS edges,
 * drop the loser.
 *
 * Limitation (v1): REL edges on the loser are dropped with it (relational facts can be
 * re-extracted). MENTIONS — the bulk of attachments — are preserved.
 */
import { writeBatch, readBatch, g, NodeRef, Predicate, PropertyInput, PropertyProjection } from "@helix-db/helix-db";
import { helix, writeWithRetry } from "../db/client.js";
import { L, E } from "../db/schema.js";
import { TENANT_ID } from "../config.js";
import { cosineSim, bestAliasSim } from "../match/scorers.js";
import { embed } from "../llm/embed.js";

interface Ent { entityKey: string; name: string; entityType: string; aliases: string[] }

async function allEntities(): Promise<Ent[]> {
  const req = readBatch().varAs("e", g().nWithLabel(L.Entity).where(Predicate.eq("tenant_id", TENANT_ID))
    .project([PropertyProjection.new("entityKey"), PropertyProjection.new("name"), PropertyProjection.new("entityType"), PropertyProjection.new("aliases")])).returning(["e"]);
  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "er_all" })).send();
  return (res.e?.properties ?? []).map((r: any) => ({ entityKey: r.entityKey, name: r.name, entityType: r.entityType, aliases: r.aliases ?? [] }));
}

export interface DuplicatePair { survivor: Ent; loser: Ent; sim: number }

/**
 * Conservative detection. Two SAME-TYPE entities are duplicates if EITHER:
 *   - they share a near-exact surface form (an exact full name in both alias sets is a
 *     strong same-entity signal that the under-merge bias split apart), or
 *   - their name embeddings are extremely close (sim ≥ highSim).
 * Embedding sim of short names is noisy ("Sarah Chen" vs "Sarah C." ≈ 0.5), so the
 * exact-shared-alias path deliberately does NOT gate on it.
 */
export async function detectDuplicates(highSim = 0.95): Promise<DuplicatePair[]> {
  const ents = await allEntities();
  if (ents.length < 2) return [];
  const vecs = await embed(ents.map((e) => e.name));

  const pairs: DuplicatePair[] = [];
  const merged = new Set<string>(); // don't reuse a node in two merges per pass
  for (let i = 0; i < ents.length; i++) {
    for (let j = i + 1; j < ents.length; j++) {
      if (merged.has(ents[i].entityKey) || merged.has(ents[j].entityKey)) continue;
      if (ents[i].entityType !== ents[j].entityType) continue; // different kinds can't be the same thing
      const sim = cosineSim(vecs[i], vecs[j]);
      const surfacesI = [ents[i].name, ...ents[i].aliases];
      const surfacesJ = [ents[j].name, ...ents[j].aliases];
      const exactShared = Math.max(...surfacesI.map((s) => bestAliasSim(s, surfacesJ))) >= 0.95;
      const isDup = exactShared || sim >= highSim;
      if (!isDup) continue;
      // survivor = the node with more aliases (keeps the richer one), tie-break by key.
      const [survivor, loser] = ents[i].aliases.length >= ents[j].aliases.length ? [ents[i], ents[j]] : [ents[j], ents[i]];
      pairs.push({ survivor, loser, sim });
      merged.add(survivor.entityKey);
      merged.add(loser.entityKey);
    }
  }
  return pairs;
}

async function mergeEntities(p: DuplicatePair): Promise<void> {
  const aliases = [...new Set([p.survivor.name, ...p.survivor.aliases, p.loser.name, ...p.loser.aliases].map((s) => s.trim()).filter(Boolean))];
  const req = writeBatch()
    .varAs("surv", g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", p.survivor.entityKey))
      .setProperty("aliases", PropertyInput.value(aliases))
      .setProperty("aliasText", PropertyInput.value(aliases.join(" ")))
      .setProperty("updatedAt", PropertyInput.value(new Date().toISOString())))
    // re-point MENTIONS: every memory that mentioned the loser now mentions the survivor
    .varAs("repoint", g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", p.loser.entityKey)).in(E.MENTIONS)
      .addE(E.MENTIONS, NodeRef.var("surv"), { tenant_id: PropertyInput.value(TENANT_ID), role: PropertyInput.value("mention") }))
    // drop the loser (removes its now-stale edges)
    .varAs("drop", g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", p.loser.entityKey)).drop())
    .returning(["surv", "repoint", "drop"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "er_merge" }));
}

export async function erRepairSweep(): Promise<{ merged: number; pairs: { survivor: string; loser: string; sim: number }[] }> {
  const pairs = await detectDuplicates();
  for (const p of pairs) await mergeEntities(p);
  return { merged: pairs.length, pairs: pairs.map((p) => ({ survivor: p.survivor.name, loser: p.loser.name, sim: +p.sim.toFixed(3) })) };
}
