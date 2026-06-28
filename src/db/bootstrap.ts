/**
 * Idempotent index bootstrap (build order step 1). Run once before any write/read;
 * createIndexIfNotExists makes re-runs safe. Tenant-partitioned vector/text indexes
 * use property name "tenant_id" (required by Helix); searches pass tenant_id as the
 * tenant value.
 */
import { writeBatch, g, IndexSpec } from "@helix-db/helix-db";
import { helix } from "./client.js";
import { L } from "./schema.js";
import { audit } from "../audit/emit.js";

// Each index as [varName, spec]. NOTE: varAs returns a NEW batch (it does not
// mutate), so entries MUST be chained/reduced — calling b.varAs(...) and dropping
// the return silently loses the entry.
const INDEXES: [string, any][] = [
  // Entity
  ["entity_key", IndexSpec.nodeUniqueEquality(L.Entity, "entityKey")],
  ["entity_tenant", IndexSpec.nodeEquality(L.Entity, "tenant_id")],
  ["entity_type", IndexSpec.nodeEquality(L.Entity, "entityType")],
  ["entity_vec", IndexSpec.nodeVector(L.Entity, "embedding", "tenant_id")],
  ["entity_text", IndexSpec.nodeText(L.Entity, "aliasText", "tenant_id")],
  // Memory
  ["mem_id", IndexSpec.nodeUniqueEquality(L.Memory, "memoryId")],
  ["mem_tenant", IndexSpec.nodeEquality(L.Memory, "tenant_id")],
  ["mem_user", IndexSpec.nodeEquality(L.Memory, "userId")],
  ["mem_type", IndexSpec.nodeEquality(L.Memory, "primaryType")],
  ["mem_kind", IndexSpec.nodeEquality(L.Memory, "kind")],
  ["mem_basis", IndexSpec.nodeEquality(L.Memory, "basis")],
  ["mem_latest", IndexSpec.nodeEquality(L.Memory, "isLatest")],
  ["mem_expires", IndexSpec.nodeRange(L.Memory, "expiresAt")], // contextual TTL sweep
  ["mem_event", IndexSpec.nodeRange(L.Memory, "eventStartAt")], // episodic/temporal recall
  ["mem_last_revised", IndexSpec.nodeRange(L.Memory, "lastRevisedAt")],
  // Helix 2.0.5 exposes only single-property equality/range specs, so we materialize
  // the `(primaryType, kind)` composite into one indexed key on write.
  ["mem_type_kind", IndexSpec.nodeEquality(L.Memory, "primaryTypeKindKey")],
  ["mem_vec", IndexSpec.nodeVector(L.Memory, "embedding", "tenant_id")],
  ["mem_text", IndexSpec.nodeText(L.Memory, "content", "tenant_id")],
  // Category
  ["cat_key", IndexSpec.nodeUniqueEquality(L.Category, "categoryKey")],
  ["cat_tenant", IndexSpec.nodeEquality(L.Category, "tenant_id")],
  // Session
  ["sess_id", IndexSpec.nodeUniqueEquality(L.Session, "sessionId")],
  ["sess_tenant", IndexSpec.nodeEquality(L.Session, "tenant_id")],
  ["sess_user", IndexSpec.nodeEquality(L.Session, "userId")],
];

function bootstrapIndexes() {
  const b = INDEXES.reduce(
    (batch, [name, spec]) => batch.varAs(name, g().createIndexIfNotExists(spec)),
    writeBatch(),
  );
  return b.returning(INDEXES.map(([name]) => name));
}

async function main() {
  const startedAt = Date.now();
  try {
    const req = bootstrapIndexes().toDynamicRequest({ queryName: "bootstrap_indexes" });
    const res = await helix.query().shouldAwaitDurability(true).dynamic(req).send();
    console.log("bootstrap OK:", JSON.stringify(res).slice(0, 300));
    // Spool path (no SQLite sink in this one-shot process); the worker drains it on start.
    audit({
      category: "SYSTEM/bootstrap", actor: "worker",
      summary: `bootstrapped ${INDEXES.length} Helix index(es)`,
      details: { indexes: INDEXES.length }, durationMs: Date.now() - startedAt,
    });
  } catch (e: any) {
    audit({
      category: "SYSTEM/bootstrap", actor: "worker", status: "error",
      summary: `bootstrap failed: ${e?.message ?? e}`,
      details: { error: String(e?.message ?? e) }, durationMs: Date.now() - startedAt,
    });
    throw e;
  }
}

main().catch((e) => { console.error("bootstrap FAILED:", e?.message ?? e); process.exit(1); });
