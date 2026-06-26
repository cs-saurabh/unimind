/**
 * Entity data-access: candidate fetch (block step of the matching engine) and
 * create/link writes. Candidates come from BOTH a tenant-scoped vector search
 * (semantic) and a BM25 search over aliasText (exact surface forms), unioned by key.
 */
import {
  writeBatch, readBatch, g, NodeRef, Predicate, PropertyInput, Expr, PropertyProjection,
} from "@helix-db/helix-db";
import { helix, writeWithRetry } from "./client.js";
import { L, normalizeKey, type EntityType } from "./schema.js";
import { TENANT_ID } from "../config.js";

export interface EntityCandidate {
  entityKey: string;
  name: string;
  aliases: string[];
  vectorSim?: number; // from vector search ($distance → sim), when present
}

/** Block step: union of vector + BM25 candidates for one mention cluster. */
export async function searchEntityCandidates(
  queryText: string,
  queryEmbedding: number[],
  k = 8,
): Promise<EntityCandidate[]> {
  const proj = [
    PropertyProjection.new("entityKey"),
    PropertyProjection.new("name"),
    PropertyProjection.new("aliases"),
    PropertyProjection.renamed("$distance", "distance"),
  ];
  const req = readBatch()
    .varAs("vec", g().vectorSearchNodesWith(L.Entity, "embedding",
      PropertyInput.value(queryEmbedding), Expr.val(k), PropertyInput.value(TENANT_ID)).project(proj))
    .varAs("bm", g().textSearchNodesWith(L.Entity, "aliasText",
      PropertyInput.value(queryText), Expr.val(k), PropertyInput.value(TENANT_ID)).project(proj))
    .returning(["vec", "bm"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "entity_candidates" })).send();
  const byKey = new Map<string, EntityCandidate>();
  for (const row of res.vec?.properties ?? []) {
    byKey.set(row.entityKey, {
      entityKey: row.entityKey, name: row.name, aliases: row.aliases ?? [],
      vectorSim: 1 / (1 + Math.max(0, row.distance ?? 1)),
    });
  }
  for (const row of res.bm?.properties ?? []) {
    if (!byKey.has(row.entityKey)) {
      byKey.set(row.entityKey, { entityKey: row.entityKey, name: row.name, aliases: row.aliases ?? [] });
    }
  }
  return [...byKey.values()];
}

const nowIso = () => new Date().toISOString();

/** Create a fresh canonical entity node (under-merge bias picks this when unsure). */
export async function createEntity(opts: {
  name: string; entityType: EntityType; surfaceForms: string[]; embedding: number[]; confidence: number;
}): Promise<string> {
  const entityKey = normalizeKey(TENANT_ID, opts.name);
  const aliases = [...new Set([opts.name, ...opts.surfaceForms].map((s) => s.trim()).filter(Boolean))];
  const now = nowIso();
  const req = writeBatch().varAs("e", g().addN(L.Entity, {
    entityKey: PropertyInput.value(entityKey), tenant_id: PropertyInput.value(TENANT_ID),
    name: PropertyInput.value(opts.name), entityType: PropertyInput.value(opts.entityType),
    aliases: PropertyInput.value(aliases), aliasText: PropertyInput.value(aliases.join(" ")),
    embedding: PropertyInput.value(opts.embedding), confidence: PropertyInput.value(opts.confidence),
    createdAt: PropertyInput.value(now), updatedAt: PropertyInput.value(now),
  })).returning(["e"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "entity_create" }));
  return entityKey;
}

/** Link to an existing entity: merge any new surface forms into its alias set. */
export async function addAliases(entityKey: string, existing: string[], newForms: string[]): Promise<void> {
  const merged = [...new Set([...existing, ...newForms].map((s) => s.trim()).filter(Boolean))];
  if (merged.length === existing.length) return; // nothing new
  const req = writeBatch().varAs("e", g().nWithLabel(L.Entity)
    .where(Predicate.eq("entityKey", entityKey))
    .setProperty("aliases", PropertyInput.value(merged))
    .setProperty("aliasText", PropertyInput.value(merged.join(" ")))
    .setProperty("updatedAt", PropertyInput.value(nowIso()))
  ).returning(["e"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "entity_add_aliases" }));
}
