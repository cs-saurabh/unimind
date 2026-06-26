/**
 * Memory writes. Step 3 is NAIVE ADD: create the Memory node + its MENTIONS edges
 * (+ a REL edge between entities when the memory is relational, §5.5). Conflict
 * dispatch / dedup / supersede arrives in step 5 — here every candidate is added.
 */
import { randomUUID } from "node:crypto";
import { writeBatch, g, NodeRef, Predicate, PropertyInput, Expr } from "@helix-db/helix-db";
import { writeWithRetry } from "./client.js";
import { L, E, type PrimaryType } from "./schema.js";
import { TENANT_ID, USER_ID } from "../config.js";

/** Per-type decay policy (§4) and contextual TTL. */
function decayFor(type: PrimaryType): { decayPolicy: string; ttlMs: number | null } {
  switch (type) {
    case "PROCEDURAL": return { decayPolicy: "evergreen", ttlMs: null };
    case "CONTEXTUAL": return { decayPolicy: "fast", ttlMs: 24 * 60 * 60_000 };
    case "GOAL": return { decayPolicy: "goal-lifecycle", ttlMs: null };
    default: return { decayPolicy: "slow", ttlMs: null }; // EPISODIC, SEMANTIC
  }
}

export interface PersistInput {
  content: string;
  primaryType: PrimaryType;
  tags: string[];
  embedding: number[];
  confidence: number;
  salience: number; // → initial weight
  mentionKeys: string[]; // resolved entityKeys this memory mentions
  // subject/object names denormalized so relational recall avoids edge-endpoint projection
  relation?: { subjectKey: string; subjectName: string; predicate: string; objectKey: string; objectName: string } | null;
  sessionId?: string;
  temporalText?: string | null;
}

export async function persistMemory(m: PersistInput): Promise<string> {
  const memoryId = randomUUID();
  const now = new Date().toISOString();
  const { decayPolicy, ttlMs } = decayFor(m.primaryType);
  const expiresAt = ttlMs ? new Date(Date.parse(now) + ttlMs).toISOString() : null;

  const node: Record<string, any> = {
    memoryId: PropertyInput.value(memoryId), tenant_id: PropertyInput.value(TENANT_ID),
    userId: PropertyInput.value(USER_ID), primaryType: PropertyInput.value(m.primaryType),
    tags: PropertyInput.value(m.tags), content: PropertyInput.value(m.content),
    embedding: PropertyInput.value(m.embedding), weight: PropertyInput.value(m.salience),
    confidence: PropertyInput.value(m.confidence), isLatest: PropertyInput.value(true),
    createdAt: PropertyInput.value(now), updatedAt: PropertyInput.value(now),
    lastAccessedAt: PropertyInput.value(now), accessCount: PropertyInput.value(0),
    validFrom: PropertyInput.value(now), decayPolicy: PropertyInput.value(decayPolicy),
  };
  if (expiresAt) node.expiresAt = PropertyInput.value(expiresAt);
  if (m.primaryType === "GOAL") node.status = PropertyInput.value("active");
  if (m.sessionId) node.sourceSessionId = PropertyInput.value(m.sessionId);
  if (m.temporalText) node.temporalText = PropertyInput.value(m.temporalText);

  let b = writeBatch().varAs("m", g().addN(L.Memory, node));

  // MENTIONS edges: memory -> each canonical entity (§6 hard rule).
  m.mentionKeys.forEach((key, i) => {
    b = b
      .varAs(`e${i}`, g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", key)))
      .varAs(`ment${i}`, g().n(NodeRef.var("m")).addE(E.MENTIONS, NodeRef.var(`e${i}`), {
        tenant_id: PropertyInput.value(TENANT_ID), role: PropertyInput.value("mention"),
      }));
  });

  // REL edge: subject entity -> object entity (relational memory, §5.5).
  if (m.relation) {
    b = b
      .varAs("subj", g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", m.relation.subjectKey)))
      .varAs("obj", g().nWithLabel(L.Entity).where(Predicate.eq("entityKey", m.relation.objectKey)))
      .varAs("rel", g().n(NodeRef.var("subj")).addE(E.REL, NodeRef.var("obj"), {
        tenant_id: PropertyInput.value(TENANT_ID), predicate: PropertyInput.value(m.relation.predicate),
        subjectName: PropertyInput.value(m.relation.subjectName), objectName: PropertyInput.value(m.relation.objectName),
        weight: PropertyInput.value(m.salience), validFrom: PropertyInput.value(now),
        createdAt: PropertyInput.value(now),
      }));
  }

  await writeWithRetry(b.returning(["m"]).toDynamicRequest({ queryName: "memory_persist" }));
  return memoryId;
}

/**
 * Supersede an old memory with a new one (§5.6 bitemporal): link new -UPDATES-> old,
 * set old isLatest=false and validTo=now. With hardDelete (contextual latest-wins),
 * also tombstone the old record so it leaves recall entirely.
 */
export async function supersede(newId: string, oldId: string, reason: string, hardDelete = false): Promise<void> {
  const now = new Date().toISOString();
  let old = g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", oldId))
    .setProperty("isLatest", PropertyInput.value(false))
    .setProperty("validTo", PropertyInput.value(now));
  if (hardDelete) old = old.setProperty("deletedAt", PropertyInput.value(now));
  const req = writeBatch()
    .varAs("old", old)
    .varAs("new", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", newId)))
    .varAs("e", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", newId))
      .addE(E.UPDATES, NodeRef.var("old"), {
        tenant_id: PropertyInput.value(TENANT_ID), reason: PropertyInput.value(reason), at: PropertyInput.value(now),
      }))
    .returning(["old", "new", "e"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "memory_supersede" }));
}

/** Enrich an existing memory without replacing it: new -EXTENDS-> old (§4 procedural/semantic). */
export async function linkExtends(newId: string, oldId: string): Promise<void> {
  const now = new Date().toISOString();
  const req = writeBatch()
    .varAs("old", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", oldId)))
    .varAs("e", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", newId))
      .addE(E.EXTENDS, NodeRef.var("old"), {
        tenant_id: PropertyInput.value(TENANT_ID), confidence: PropertyInput.value(0.8), at: PropertyInput.value(now),
      }))
    .returning(["old", "e"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "memory_extends" }));
}

/** Transition a GOAL's lifecycle state (§4 goal-driven: active → completed/abandoned). */
export async function setGoalStatus(memoryId: string, status: "completed" | "abandoned"): Promise<void> {
  const now = new Date().toISOString();
  const req = writeBatch().varAs("g", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", memoryId))
    .setProperty("status", PropertyInput.value(status))
    .setProperty("updatedAt", PropertyInput.value(now))
  ).returning(["g"]);
  await writeWithRetry(req.toDynamicRequest({ queryName: "goal_status" }));
}

/**
 * Reinforce-on-retrieval (§5.11, §7 read step 7): bump weight, accessCount, and
 * lastAccessedAt for memories that were used. Use-it-or-lose-it — unused memories
 * decay, used ones stay strong.
 */
export async function bumpMemories(memoryIds: string[], boost = 0.1): Promise<void> {
  if (memoryIds.length === 0) return;
  const now = new Date().toISOString();
  let b = writeBatch();
  memoryIds.forEach((id, i) => {
    b = b.varAs(`m${i}`, g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", id))
      .setProperty("weight", Expr.prop("weight").add(Expr.val(boost)))
      .setProperty("accessCount", Expr.prop("accessCount").add(Expr.val(1)))
      .setProperty("lastAccessedAt", PropertyInput.value(now)));
  });
  await writeWithRetry(b.returning(memoryIds.map((_, i) => `m${i}`)).toDynamicRequest({ queryName: "memory_bump" }));
}
