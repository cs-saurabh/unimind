/**
 * Read-path Helix queries (§7 read step 4) — type-specific recall, all filtered to
 * CURRENT/visible memories (§ "Current Scoped Memory Filter"). Callers run these in
 * parallel and fuse/rank app-side. $distance is projected before any traversal.
 */
import { readBatch, g, Predicate, PropertyInput, Expr, PropertyProjection } from "@helix-db/helix-db";
import { helix } from "./client.js";
import { L, E, normalizeKey } from "./schema.js";
import { TENANT_ID, USER_ID } from "../config.js";

export interface RecallRow {
  memoryId: string;
  content: string;
  primaryType: string;
  weight: number;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt?: string | null;
  distance?: number; // vector/BM25 distance (smaller = closer); absent for direct loads
}

const MEM_PROJ = [
  PropertyProjection.new("memoryId"),
  PropertyProjection.new("content"),
  PropertyProjection.new("primaryType"),
  PropertyProjection.new("weight"),
  PropertyProjection.new("createdAt"),
  PropertyProjection.new("lastAccessedAt"),
  PropertyProjection.new("expiresAt"),
];
// Search projection: include the lifecycle fields so the current/expiry filter can be
// applied APP-SIDE. (Engine quirk: chaining .where() after a vector/BM25 search drops
// $distance — so search routes must NOT filter in-query; they over-fetch and filter here.)
const MEM_PROJ_DIST = [
  ...MEM_PROJ,
  PropertyProjection.new("isLatest"),
  PropertyProjection.new("validTo"),
  PropertyProjection.new("deletedAt"),
  PropertyProjection.new("userId"),
  PropertyProjection.renamed("$distance", "distance"),
];

/** isLatest && !deleted && !superseded && this user — the live/current predicate (for label scans). */
const current = () => Predicate.and([
  Predicate.eq("isLatest", true),
  Predicate.isNull("deletedAt"),
  Predicate.isNull("validTo"),
  Predicate.eq("userId", USER_ID),
]);

/** App-side equivalent of current() + TTL, for search results where in-query where drops $distance. */
function liveCurrent(rows: any[]): RecallRow[] {
  const now = Date.now();
  return rows.filter((r) =>
    r.isLatest === true && !r.deletedAt && !r.validTo && r.userId === USER_ID &&
    (!r.expiresAt || Date.parse(r.expiresAt) > now));
}

/** Drop memories whose contextual TTL has passed (expiresAt is range-only in-query; filter here). */
function notExpired(rows: RecallRow[]): RecallRow[] {
  const now = Date.now();
  return rows.filter((r) => !r.expiresAt || Date.parse(r.expiresAt) > now);
}

/** Semantic/episodic/procedural recall via vector + BM25, plus active goals + contextual state. */
export async function recall(opts: {
  queryEmbedding: number[];
  queryText: string;
  k?: number;
}): Promise<{ vector: RecallRow[]; bm25: RecallRow[]; goals: RecallRow[]; contextual: RecallRow[] }> {
  const k = opts.k ?? 12;
  const fetchK = k * 3; // over-fetch; current/expiry filter is applied app-side
  const req = readBatch()
    .varAs("vector", g().vectorSearchNodesWith(L.Memory, "embedding",
      PropertyInput.value(opts.queryEmbedding), Expr.val(fetchK), PropertyInput.value(TENANT_ID))
      .project(MEM_PROJ_DIST))
    .varAs("bm25", g().textSearchNodesWith(L.Memory, "content",
      PropertyInput.value(opts.queryText), Expr.val(fetchK), PropertyInput.value(TENANT_ID))
      .project(MEM_PROJ_DIST))
    .varAs("goals", g().nWithLabel(L.Memory)
      .where(Predicate.and([Predicate.eq("tenant_id", TENANT_ID), Predicate.eq("primaryType", "GOAL"),
        Predicate.eq("status", "active"), current()])).project(MEM_PROJ))
    .varAs("contextual", g().nWithLabel(L.Memory)
      .where(Predicate.and([Predicate.eq("tenant_id", TENANT_ID), Predicate.eq("primaryType", "CONTEXTUAL"), current()]))
      .project(MEM_PROJ))
    .returning(["vector", "bm25", "goals", "contextual"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "recall" })).send();
  const rows = (v: string): any[] => res[v]?.properties ?? [];
  return {
    vector: liveCurrent(rows("vector")).slice(0, k),
    bm25: liveCurrent(rows("bm25")).slice(0, k),
    goals: notExpired(rows("goals")),
    contextual: notExpired(rows("contextual")),
  };
}

/** Conflict-resolution block step: nearest CURRENT memories of the same type. */
export async function similarMemories(
  embedding: number[], primaryType: string, k = 5,
): Promise<RecallRow[]> {
  // No in-query where (it would drop $distance); over-fetch + filter app-side.
  const req = readBatch().varAs("hits", g()
    .vectorSearchNodesWith(L.Memory, "embedding", PropertyInput.value(embedding), Expr.val(k * 4), PropertyInput.value(TENANT_ID))
    .project(MEM_PROJ_DIST)).returning(["hits"]);
  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "similar_memories" })).send();
  return liveCurrent(res.hits?.properties ?? []).filter((r) => r.primaryType === primaryType).slice(0, k);
}

export interface RelFact { subject: string; predicate: string; object: string; weight: number }

/**
 * Relational facts touching the named entities (1 hop, both directions) — §7 read step 4.
 * Reads subject/object names denormalized onto the REL edge (the engine rejects
 * endpoint projection on edge streams), so plain edgeProperties() suffices.
 */
export async function relationalFacts(entityKeys: string[]): Promise<RelFact[]> {
  if (entityKeys.length === 0) return [];
  let b = readBatch();
  entityKeys.forEach((key, i) => {
    b = b
      .varAs(`out${i}`, g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", key)).outE(E.REL).edgeProperties())
      .varAs(`in${i}`, g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", key)).inE(E.REL).edgeProperties());
  });
  const names = entityKeys.flatMap((_, i) => [`out${i}`, `in${i}`]);
  const res: any = await helix.query().dynamic(b.returning(names).toDynamicRequest({ queryName: "rel_facts" })).send();

  const seen = new Set<string>();
  const facts: RelFact[] = [];
  for (const n of names) {
    for (const row of res[n]?.properties ?? []) {
      const key = `${row.subjectName}|${row.predicate}|${row.objectName}`;
      if (row.subjectName && row.objectName && !seen.has(key)) {
        seen.add(key);
        facts.push({ subject: row.subjectName, predicate: row.predicate, object: row.objectName, weight: row.weight ?? 0 });
      }
    }
  }
  return facts;
}

/**
 * Validate planner-proposed entity names against real canonical nodes (drop
 * hallucinations). Exact key match first; BM25 over aliasText as a fallback so
 * surface-form variation ("analytics-ui package" vs the stored name) still resolves.
 */
export async function validateEntities(names: string[]): Promise<{ entityKey: string; name: string }[]> {
  if (names.length === 0) return [];
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const ENT_PROJ = [PropertyProjection.new("entityKey"), PropertyProjection.new("name"), PropertyProjection.renamed("$distance", "distance")];

  let b = readBatch();
  uniq.forEach((name, i) => {
    b = b
      .varAs(`x${i}`, g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", normalizeKey(TENANT_ID, name)))
        .project([PropertyProjection.new("entityKey"), PropertyProjection.new("name")]))
      .varAs(`b${i}`, g().textSearchNodesWith(L.Entity, "aliasText",
        PropertyInput.value(name), Expr.val(2), PropertyInput.value(TENANT_ID)).project(ENT_PROJ));
  });
  const vars = uniq.flatMap((_, i) => [`x${i}`, `b${i}`]);
  const res: any = await helix.query().dynamic(b.returning(vars).toDynamicRequest({ queryName: "validate_entities" })).send();

  const byKey = new Map<string, string>();
  uniq.forEach((name, i) => {
    const exact = res[`x${i}`]?.properties ?? [];
    if (exact.length) { byKey.set(exact[0].entityKey, exact[0].name); return; }
    // BM25 fallback: accept only a strong textual hit (small distance) to avoid false links.
    for (const row of res[`b${i}`]?.properties ?? []) {
      if (row.entityKey && (row.distance ?? 9) < 1.5) { byKey.set(row.entityKey, row.name); break; }
    }
  });
  return [...byKey.entries()].map(([entityKey, name]) => ({ entityKey, name }));
}
