/**
 * Memory writes. Step 3 is NAIVE ADD: create the Memory node + its MENTIONS edges
 * (+ a REL edge between entities when the memory is relational, §5.5). Conflict
 * dispatch / dedup / supersede arrives in step 5 — here every candidate is added.
 */
import { randomUUID } from "node:crypto";
import {
  writeBatch,
  readBatch,
  g,
  NodeRef,
  Predicate,
  PropertyInput,
  Expr,
  PropertyProjection,
} from "@helix-db/helix-db";
import { writeWithRetry } from "./client.js";
import {
  L,
  E,
  primaryTypeKindKey,
  type ContradictionRecord,
  type MemoryBasis,
  type MemoryKind,
  type MemoryNode,
  type PrimaryType,
  type StalenessFlag,
} from "./schema.js";
import { TENANT_ID, USER_ID } from "../config.js";
import { helix } from "./client.js";
import { validateMemoryNode } from "./memoryValidation.js";
import { audit } from "../audit/emit.js";
import type { AuditActor, AuditCategory } from "../audit/types.js";

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
  kind?: MemoryKind;
  basis?: MemoryBasis;
  freshness?: number;
  derivedFrom?: string[];
  costIfIgnored?: string | null;
  lastRevisedAt?: string | null;
  stalenessFlag?: StalenessFlag | null;
  hasContradiction?: boolean;
  contradictions?: ContradictionRecord[];
  expiresAt?: string | null;
  sourceMemoryIds?: string[];
  relatedMemoryIds?: string[];
}

export interface PersistAuditMeta {
  category?: AuditCategory;
  actor?: AuditActor;
  sessionId?: string | null;
}

async function existingMemoryIds(memoryIds: string[]): Promise<Set<string>> {
  const uniq = [...new Set(memoryIds.map((id) => id.trim()).filter(Boolean))];
  if (uniq.length === 0) return new Set();

  let batch = readBatch();
  uniq.forEach((id, index) => {
    batch = batch.varAs(
      `m${index}`,
      g().nWithLabel(L.Memory)
        .where(
          Predicate.and([
            Predicate.eq("tenant_id", TENANT_ID),
            Predicate.eq("userId", USER_ID),
            Predicate.eq("memoryId", id),
            Predicate.isNull("deletedAt"),
          ]),
        )
        .project([PropertyProjection.new("memoryId")]),
    );
  });

  const vars = uniq.map((_, index) => `m${index}`);
  const res: any = await helix.query().dynamic(
    batch.returning(vars).toDynamicRequest({ queryName: "memory_validation_existing_ids" }),
  ).send();

  const found = new Set<string>();
  vars.forEach((name) => {
    for (const row of res[name]?.properties ?? []) {
      if (row.memoryId) found.add(String(row.memoryId));
    }
  });
  return found;
}

function toMemoryNode(memoryId: string, now: string, m: PersistInput): MemoryNode {
  const { decayPolicy, ttlMs } = decayFor(m.primaryType);
  const expiresAt = m.expiresAt === undefined
    ? (ttlMs ? new Date(Date.parse(now) + ttlMs).toISOString() : null)
    : m.expiresAt;

  return {
    memoryId,
    tenant_id: TENANT_ID,
    userId: USER_ID,
    primaryType: m.primaryType,
    tags: m.tags,
    kind: m.kind,
    content: m.content,
    embedding: m.embedding,
    weight: m.salience,
    confidence: m.confidence,
    freshness: m.freshness,
    basis: m.basis,
    derivedFrom: m.derivedFrom,
    costIfIgnored: m.costIfIgnored ?? undefined,
    hasContradiction: m.hasContradiction,
    contradictions: m.contradictions,
    isLatest: true,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    lastRevisedAt: m.lastRevisedAt ?? undefined,
    stalenessFlag: m.stalenessFlag ?? undefined,
    accessCount: 0,
    validFrom: now,
    expiresAt,
    decayPolicy,
    status: m.primaryType === "GOAL" ? "active" : undefined,
    sourceSessionId: m.sessionId ?? null,
  };
}

function toPropertyInputMap(node: MemoryNode): Record<string, any> {
  const out: Record<string, any> = {
    memoryId: PropertyInput.value(node.memoryId),
    tenant_id: PropertyInput.value(node.tenant_id),
    userId: PropertyInput.value(node.userId),
    primaryType: PropertyInput.value(node.primaryType),
    tags: PropertyInput.value(node.tags),
    content: PropertyInput.value(node.content),
    embedding: PropertyInput.value(node.embedding),
    weight: PropertyInput.value(node.weight),
    confidence: PropertyInput.value(node.confidence),
    isLatest: PropertyInput.value(node.isLatest),
    createdAt: PropertyInput.value(node.createdAt),
    updatedAt: PropertyInput.value(node.updatedAt),
    lastAccessedAt: PropertyInput.value(node.lastAccessedAt),
    accessCount: PropertyInput.value(node.accessCount),
    validFrom: PropertyInput.value(node.validFrom),
    decayPolicy: PropertyInput.value(node.decayPolicy),
  };

  if (node.kind != null) {
    out.kind = PropertyInput.value(node.kind);
    out.primaryTypeKindKey = PropertyInput.value(primaryTypeKindKey(node.primaryType, node.kind));
  }
  if (node.freshness != null) out.freshness = PropertyInput.value(node.freshness);
  if (node.basis != null) out.basis = PropertyInput.value(node.basis);
  if (node.derivedFrom != null) out.derivedFrom = PropertyInput.value(node.derivedFrom);
  if (node.costIfIgnored != null) out.costIfIgnored = PropertyInput.value(node.costIfIgnored);
  if (node.hasContradiction != null) out.hasContradiction = PropertyInput.value(node.hasContradiction);
  if (node.contradictions != null) {
    out.contradictions = PropertyInput.value(node.contradictions.map((entry) => ({
      withMemoryId: entry.withMemoryId,
      resolution: entry.resolution,
      confidence: entry.confidence,
      resolvedAt: entry.resolvedAt,
    })));
  }
  if (node.expiresAt != null) out.expiresAt = PropertyInput.value(node.expiresAt);
  if (node.lastRevisedAt != null) out.lastRevisedAt = PropertyInput.value(node.lastRevisedAt);
  if (node.stalenessFlag != null) out.stalenessFlag = PropertyInput.value(node.stalenessFlag);
  if (node.status != null) out.status = PropertyInput.value(node.status);
  if (node.sourceSessionId != null) out.sourceSessionId = PropertyInput.value(node.sourceSessionId);

  return out;
}

export async function persistMemory(
  m: PersistInput,
  auditMeta: PersistAuditMeta = {},
): Promise<string | null> {
  const memoryId = randomUUID();
  const now = new Date().toISOString();
  const candidate = toMemoryNode(memoryId, now, m);
  const validation = await validateMemoryNode(candidate, { existingMemoryIds });

  if (!validation.ok) {
    audit({
      category: auditMeta.category ?? "WRITE/flush",
      actor: auditMeta.actor ?? "worker",
      status: "error",
      sessionId: auditMeta.sessionId ?? m.sessionId ?? null,
      summary: `memory validation rejected ${candidate.primaryType} candidate`,
      details: {
        memoryId,
        primaryType: candidate.primaryType,
        kind: candidate.kind ?? null,
        reasons: validation.reasons,
        preview: candidate.content.slice(0, 200),
      },
    });
    return null;
  }

  const node = toPropertyInputMap(candidate);
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

  // Synthetic provenance: synthetic memory -> source memory.
  m.sourceMemoryIds?.forEach((id, i) => {
    b = b
      .varAs(`src${i}`, g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", id)))
      .varAs(`syn${i}`, g().n(NodeRef.var("m")).addE(E.SYNTHESIZED_FROM, NodeRef.var(`src${i}`), {
        tenant_id: PropertyInput.value(TENANT_ID),
        confidence: PropertyInput.value(m.confidence),
        basis: PropertyInput.value(m.basis ?? "direct_statement"),
        at: PropertyInput.value(now),
      }));
  });

  // Theme links keep synthetic and gap nodes attached to the evidence they came from.
  m.relatedMemoryIds?.forEach((id, i) => {
    b = b
      .varAs(`relm${i}`, g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", id)))
      .varAs(`theme${i}`, g().n(NodeRef.var("m")).addE(E.RELATED_TO_THEME, NodeRef.var(`relm${i}`), {
        tenant_id: PropertyInput.value(TENANT_ID),
        weight: PropertyInput.value(m.salience),
        at: PropertyInput.value(now),
      }));
  });

  await writeWithRetry(b.returning(["m"]).toDynamicRequest({ queryName: "memory_persist" }));
  return memoryId;
}

export async function refreshSyntheticMemory(opts: {
  memoryId: string;
  content: string;
  tags: string[];
  embedding: number[];
  confidence: number;
  derivedFrom: string[];
  lastRevisedAt: string;
  basis?: MemoryBasis;
  addedSourceMemoryIds?: string[];
}): Promise<void> {
  const now = new Date().toISOString();
  let req = writeBatch().varAs("m", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", opts.memoryId))
    .setProperty("content", PropertyInput.value(opts.content))
    .setProperty("tags", PropertyInput.value(opts.tags))
    .setProperty("embedding", PropertyInput.value(opts.embedding))
    .setProperty("confidence", PropertyInput.value(opts.confidence))
    .setProperty("basis", PropertyInput.value(opts.basis ?? "pattern_analysis"))
    .setProperty("kind", PropertyInput.value("synthetic"))
    .setProperty("primaryTypeKindKey", PropertyInput.value(primaryTypeKindKey("SEMANTIC", "synthetic")))
    .setProperty("derivedFrom", PropertyInput.value(opts.derivedFrom))
    .setProperty("lastRevisedAt", PropertyInput.value(opts.lastRevisedAt))
    .setProperty("updatedAt", PropertyInput.value(now)),
  );

  opts.addedSourceMemoryIds?.forEach((id, i) => {
    req = req
      .varAs(`src${i}`, g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", id)))
      .varAs(`edge${i}`, g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", opts.memoryId))
        .addE(E.SYNTHESIZED_FROM, NodeRef.var(`src${i}`), {
          tenant_id: PropertyInput.value(TENANT_ID),
          confidence: PropertyInput.value(opts.confidence),
          basis: PropertyInput.value(opts.basis ?? "pattern_analysis"),
          at: PropertyInput.value(now),
        }));
  });

  await writeWithRetry(req.returning(["m"]).toDynamicRequest({ queryName: "refresh_synthetic_memory" }));
}

export async function flagContradictionPair(opts: {
  leftMemoryId: string;
  rightMemoryId: string;
  resolution: string;
  confidence: number;
  resolvedAt: string;
}): Promise<boolean> {
  const req = readBatch()
    .varAs("left", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", opts.leftMemoryId)).project([
      PropertyProjection.new("memoryId"),
      PropertyProjection.new("contradictions"),
      PropertyProjection.new("hasContradiction"),
    ]))
    .varAs("right", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", opts.rightMemoryId)).project([
      PropertyProjection.new("memoryId"),
      PropertyProjection.new("contradictions"),
      PropertyProjection.new("hasContradiction"),
    ]))
    .returning(["left", "right"]);
  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "contradiction_pair_read" })).send();

  const left = res.left?.properties?.[0];
  const right = res.right?.properties?.[0];
  if (!left?.memoryId || !right?.memoryId) return false;

  const existingLeft: ContradictionRecord[] = Array.isArray(left.contradictions)
    ? left.contradictions.map((entry: any) => ({
        withMemoryId: String(entry.withMemoryId),
        resolution: String(entry.resolution),
        confidence: Number(entry.confidence),
        resolvedAt: String(entry.resolvedAt),
      }))
    : [];
  const existingRight: ContradictionRecord[] = Array.isArray(right.contradictions)
    ? right.contradictions.map((entry: any) => ({
        withMemoryId: String(entry.withMemoryId),
        resolution: String(entry.resolution),
        confidence: Number(entry.confidence),
        resolvedAt: String(entry.resolvedAt),
      }))
    : [];

  const hasLeft = existingLeft.some((entry) => entry.withMemoryId === opts.rightMemoryId);
  const hasRight = existingRight.some((entry) => entry.withMemoryId === opts.leftMemoryId);
  if (hasLeft && hasRight) return false;

  const leftRecord: ContradictionRecord = {
    withMemoryId: opts.rightMemoryId,
    resolution: opts.resolution,
    confidence: opts.confidence,
    resolvedAt: opts.resolvedAt,
  };
  const rightRecord: ContradictionRecord = {
    withMemoryId: opts.leftMemoryId,
    resolution: opts.resolution,
    confidence: opts.confidence,
    resolvedAt: opts.resolvedAt,
  };

  const mergedLeft = hasLeft ? existingLeft : [...existingLeft, leftRecord];
  const mergedRight = hasRight ? existingRight : [...existingRight, rightRecord];
  const now = new Date().toISOString();

  let write = writeBatch()
    .varAs("left", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", opts.leftMemoryId))
      .setProperty("hasContradiction", PropertyInput.value(true))
      .setProperty("contradictions", PropertyInput.value(mergedLeft.map((entry) => ({
        withMemoryId: entry.withMemoryId,
        resolution: entry.resolution,
        confidence: entry.confidence,
        resolvedAt: entry.resolvedAt,
      }))))
      .setProperty("updatedAt", PropertyInput.value(now)))
    .varAs("right", g().nWithLabel(L.Memory).where(Predicate.eq("memoryId", opts.rightMemoryId))
      .setProperty("hasContradiction", PropertyInput.value(true))
      .setProperty("contradictions", PropertyInput.value(mergedRight.map((entry) => ({
        withMemoryId: entry.withMemoryId,
        resolution: entry.resolution,
        confidence: entry.confidence,
        resolvedAt: entry.resolvedAt,
      }))))
      .setProperty("updatedAt", PropertyInput.value(now)));

  if (!hasLeft || !hasRight) {
    write = write
      .varAs("left_edge", g().n(NodeRef.var("left")).addE(E.CONTRADICTS, NodeRef.var("right"), {
        tenant_id: PropertyInput.value(TENANT_ID),
        resolution: PropertyInput.value(opts.resolution),
        confidence: PropertyInput.value(opts.confidence),
        resolvedAt: PropertyInput.value(opts.resolvedAt),
      }))
      .varAs("right_edge", g().n(NodeRef.var("right")).addE(E.CONTRADICTS, NodeRef.var("left"), {
        tenant_id: PropertyInput.value(TENANT_ID),
        resolution: PropertyInput.value(opts.resolution),
        confidence: PropertyInput.value(opts.confidence),
        resolvedAt: PropertyInput.value(opts.resolvedAt),
      }));
  }

  await writeWithRetry(write.returning(["left", "right"]).toDynamicRequest({ queryName: "contradiction_pair_write" }));
  return true;
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
