/**
 * Schema smoke test: write Entity + Memory nodes with real embeddings, link a
 * MENTIONS edge and a REL edge, then exercise every read modality the system
 * depends on — unique-index lookup, tenant-scoped vector search, BM25 text search,
 * and graph traversal. Cleans up after itself. Proves build step 1 is usable.
 */
import {
  writeBatch, readBatch, g, NodeRef,
  Predicate, PropertyInput, Expr, PropertyProjection, IndexSpec,
} from "@helix-db/helix-db";
import { helix } from "./client.js";
import { L, E, normalizeKey } from "./schema.js";
import { TENANT_ID, USER_ID } from "../config.js";
import { embed } from "../llm/embed.js";

const now = new Date().toISOString();
const tag = "smoke-fixture"; // fixed so the test is idempotent

async function cleanup(sarahKey: string, engKey: string) {
  const clean = writeBatch()
    .varAs("dm", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", `${tag}-lead`)).drop())
    .varAs("dm2", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", `${tag}-pref`)).drop())
    .varAs("de", g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", sarahKey)).drop())
    .varAs("de2", g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", engKey)).drop())
    .returning(["dm", "dm2", "de", "de2"]);
  await helix.query().shouldAwaitDurability(true).dynamic(clean.toDynamicRequest({ queryName: "smoke_clean" })).send();
}

async function main() {
  const [eSarah, eEng, mLead, mPref] = await embed([
    "Sarah Chen, engineering lead",
    "Engineering organization",
    "Sarah leads the Engineering org",
    "User prefers morning standups over afternoon meetings",
  ]);

  const sarahKey = normalizeKey(TENANT_ID, "Sarah Chen");
  const engKey = normalizeKey(TENANT_ID, "Engineering");

  await cleanup(sarahKey, engKey); // remove any leftovers from a prior run

  // ---- WRITE: two entities, two memories, MENTIONS + REL edges ----
  const w = writeBatch()
    .varAs("sarah", g().addN(L.Entity, {
      entityKey: PropertyInput.value(sarahKey), tenant_id: PropertyInput.value(TENANT_ID),
      name: PropertyInput.value("Sarah Chen"), entityType: PropertyInput.value("person"),
      aliases: PropertyInput.value(["Sarah", "S. Chen", tag]), aliasText: PropertyInput.value(`Sarah S. Chen ${tag}`),
      embedding: PropertyInput.value(eSarah), confidence: PropertyInput.value(0.95),
      createdAt: PropertyInput.value(now), updatedAt: PropertyInput.value(now),
    }))
    .varAs("eng", g().addN(L.Entity, {
      entityKey: PropertyInput.value(engKey), tenant_id: PropertyInput.value(TENANT_ID),
      name: PropertyInput.value("Engineering"), entityType: PropertyInput.value("org"),
      aliases: PropertyInput.value(["Engineering", "Eng"]), aliasText: PropertyInput.value("Engineering Eng"),
      embedding: PropertyInput.value(eEng), confidence: PropertyInput.value(0.9),
      createdAt: PropertyInput.value(now), updatedAt: PropertyInput.value(now),
    }))
    .varAs("mLead", g().addN(L.Memory, {
      memoryId: PropertyInput.value(`${tag}-lead`), tenant_id: PropertyInput.value(TENANT_ID),
      userId: PropertyInput.value(USER_ID), primaryType: PropertyInput.value("SEMANTIC"),
      tags: PropertyInput.value([tag]), content: PropertyInput.value("Sarah leads the Engineering org"),
      embedding: PropertyInput.value(mLead), weight: PropertyInput.value(1.0), confidence: PropertyInput.value(0.9),
      isLatest: PropertyInput.value(true), createdAt: PropertyInput.value(now), updatedAt: PropertyInput.value(now),
      lastAccessedAt: PropertyInput.value(now), accessCount: PropertyInput.value(0),
      validFrom: PropertyInput.value(now), decayPolicy: PropertyInput.value("slow"),
    }))
    .varAs("mPref", g().addN(L.Memory, {
      memoryId: PropertyInput.value(`${tag}-pref`), tenant_id: PropertyInput.value(TENANT_ID),
      userId: PropertyInput.value(USER_ID), primaryType: PropertyInput.value("SEMANTIC"),
      tags: PropertyInput.value([tag]), content: PropertyInput.value("User prefers morning standups over afternoon meetings"),
      embedding: PropertyInput.value(mPref), weight: PropertyInput.value(1.0), confidence: PropertyInput.value(0.8),
      isLatest: PropertyInput.value(true), createdAt: PropertyInput.value(now), updatedAt: PropertyInput.value(now),
      lastAccessedAt: PropertyInput.value(now), accessCount: PropertyInput.value(0),
      validFrom: PropertyInput.value(now), decayPolicy: PropertyInput.value("slow"),
    }))
    .varAs("mentions", g().n(NodeRef.var("mLead")).addE(E.MENTIONS, NodeRef.var("sarah"), {
      tenant_id: PropertyInput.value(TENANT_ID), role: PropertyInput.value("subject"),
    }))
    .varAs("rel", g().n(NodeRef.var("sarah")).addE(E.REL, NodeRef.var("eng"), {
      tenant_id: PropertyInput.value(TENANT_ID), predicate: PropertyInput.value("leads"),
      weight: PropertyInput.value(0.98), validFrom: PropertyInput.value(now), createdAt: PropertyInput.value(now),
    }))
    .returning(["mLead", "mPref", "rel"]);

  await helix.query().shouldAwaitDurability(true).dynamic(w.toDynamicRequest({ queryName: "smoke_write" })).send();
  console.log("✓ write: 2 entities, 2 memories, MENTIONS + REL edges");

  // ---- READ 1: unique-index lookup by memoryId ----
  const byId = readBatch().varAs("m", g().nWithLabel(L.Memory)
    .where(Predicate.eq("memoryId", `${tag}-lead`))
    .project([PropertyProjection.new("content"), PropertyProjection.new("primaryType")])
  ).returning(["m"]);
  const r1: any = await helix.query().dynamic(byId.toDynamicRequest({ queryName: "smoke_by_id" })).send();
  console.log("✓ by memoryId:", JSON.stringify(r1.m ?? r1));

  // ---- READ 2: tenant-scoped vector search (project $distance before any traversal) ----
  const [qVec] = await embed(["who runs engineering"]);
  const vec = readBatch().varAs("hits", g()
    .vectorSearchNodesWith(L.Memory, "embedding", PropertyInput.value(qVec), Expr.val(3), PropertyInput.value(TENANT_ID))
    .project([PropertyProjection.new("content"), PropertyProjection.renamed("$distance", "distance")])
  ).returning(["hits"]);
  const r2: any = await helix.query().dynamic(vec.toDynamicRequest({ queryName: "smoke_vec" })).send();
  console.log("✓ vector search 'who runs engineering':", JSON.stringify(r2.hits ?? r2));

  // ---- READ 3: BM25 text search ----
  const bm = readBatch().varAs("hits", g()
    .textSearchNodesWith(L.Memory, "content", PropertyInput.value("standups morning"), Expr.val(3), PropertyInput.value(TENANT_ID))
    .project([PropertyProjection.new("content"), PropertyProjection.renamed("$distance", "score")])
  ).returning(["hits"]);
  const r3: any = await helix.query().dynamic(bm.toDynamicRequest({ queryName: "smoke_bm25" })).send();
  console.log("✓ BM25 search 'standups morning':", JSON.stringify(r3.hits ?? r3));

  // ---- READ 4: graph traversal — entity -> REL -> entity ----
  const trav = readBatch().varAs("rels", g().nWithLabel(L.Entity)
    .where(Predicate.eq("entityKey", sarahKey)).outE(E.REL).edgeProperties()
  ).returning(["rels"]);
  const r4: any = await helix.query().dynamic(trav.toDynamicRequest({ queryName: "smoke_trav" })).send();
  console.log("✓ traversal Sarah -REL->:", JSON.stringify(r4.rels ?? r4));

  // ---- CLEANUP ----
  await cleanup(sarahKey, engKey);
  console.log("✓ cleanup done");
}

main().catch((e) => { console.error("SMOKE FAILED:", e?.message ?? e); process.exit(1); });
