/**
 * Flush orchestration (§7 write steps 4-7): extract over the window → embed →
 * resolve entities (under-merge) → naive ADD memories + edges → clear the buffer.
 */
import type { BufferStore } from "./buffer.js";
import type { FlushReason } from "./types.js";
import { extractWindow } from "./extract.js";
import { resolveEntity } from "./entityResolve.js";
import { resolveConflict } from "./conflict.js";
import { persistMemory, bumpMemories, supersede, linkExtends } from "../db/memories.js";
import { embed } from "../llm/embed.js";
import { audit } from "../audit/emit.js";
import type { AuditActor, AuditCategory } from "../audit/types.js";

/** Lets the remember() path log as WRITE/remember (skill) instead of WRITE/flush (worker). */
export interface FlushAuditMeta {
  category?: AuditCategory;
  actor?: AuditActor;
}

export interface FlushSummary {
  sessionId: string;
  reason: FlushReason | "manual";
  memories: number; // newly written
  reinforced: number; // duplicates that bumped an existing memory instead
  superseded: number; // old memories superseded by a correction
  entitiesCreated: number;
  entitiesLinked: number;
}

export async function flushSession(
  store: BufferStore,
  sessionId: string,
  reason: FlushReason | "manual" = "manual",
  auditMeta: FlushAuditMeta = {},
): Promise<FlushSummary> {
  const startedAt = Date.now();
  const category: AuditCategory = auditMeta.category ?? "WRITE/flush";
  const actor: AuditActor = auditMeta.actor ?? "worker";
  const empty: FlushSummary = { sessionId, reason, memories: 0, reinforced: 0, superseded: 0, entitiesCreated: 0, entitiesLinked: 0 };

  const buf = await store.get(sessionId);
  if (!buf || buf.turns.length === 0) return empty; // nothing to flush → not an operation, no audit row

  try {
    const ext = await extractWindow(buf);
    if (ext.memories.length === 0 && ext.clusters.length === 0) {
      await store.clear(sessionId);
      audit({
        category, actor, sessionId,
        summary: `${reason} flush → nothing durable extracted`,
        details: { turns: buf.turns.length, ...empty }, durationMs: Date.now() - startedAt,
      });
      return empty;
    }

    // One embedding batch for all entity names + memory contents.
    const clusterTexts = ext.clusters.map((c) => c.canonicalName);
    const memTexts = ext.memories.map((m) => m.content);
    const vecs = await embed([...clusterTexts, ...memTexts]);
    const clusterVecs = vecs.slice(0, clusterTexts.length);
    const memVecs = vecs.slice(clusterTexts.length);

    // Resolve every mention cluster to a canonical entityKey (link or create).
    let created = 0, linked = 0;
    const clusterKey: string[] = [];
    for (let i = 0; i < ext.clusters.length; i++) {
      const r = await resolveEntity(ext.clusters[i], clusterVecs[i]);
      clusterKey[i] = r.entityKey;
      if (r.action === "created") created++; else linked++;
    }

    // Conflict-dispatched write (§4 / step 5): dedup, supersede, extend, or add.
    let written = 0, reinforced = 0, superseded = 0;
    const writtenIds: string[] = [];
    for (let i = 0; i < ext.memories.length; i++) {
      const m = ext.memories[i];
      const action = await resolveConflict(m, memVecs[i]);

      if (action.kind === "skip") {
        await bumpMemories([action.targetId]); // reinforce the existing duplicate
        reinforced++;
        continue;
      }

      const mentionKeys = [...new Set(m.mentionRefs.map((r) => clusterKey[r]).filter(Boolean))];
      const relation = m.relation && clusterKey[m.relation.subjectRef] && clusterKey[m.relation.objectRef]
        ? {
            subjectKey: clusterKey[m.relation.subjectRef], subjectName: ext.clusters[m.relation.subjectRef].canonicalName,
            predicate: m.relation.predicate,
            objectKey: clusterKey[m.relation.objectRef], objectName: ext.clusters[m.relation.objectRef].canonicalName,
          }
        : null;
      const newId = await persistMemory({
        content: m.content, primaryType: m.primaryType, tags: m.tags, embedding: memVecs[i],
        confidence: m.confidence, salience: m.salience, mentionKeys, relation,
        sessionId, temporalText: m.temporalText,
      });
      written++;
      writtenIds.push(newId);

      if (action.kind === "supersede") {
        await supersede(newId, action.targetId, `superseded on ${reason}`, action.hardDelete);
        superseded++;
      } else if (action.kind === "extend") {
        await linkExtends(newId, action.targetId);
      }
    }

    await store.clear(sessionId);
    const summary: FlushSummary = { sessionId, reason, memories: written, reinforced, superseded, entitiesCreated: created, entitiesLinked: linked };
    audit({
      category, actor, sessionId,
      summary: `${reason} → +${written} mem` +
        (reinforced ? `, ${reinforced} reinforced` : "") +
        (superseded ? `, ${superseded} superseded` : "") +
        (created || linked ? ` (entities: +${created} new, ${linked} linked)` : ""),
      details: { turns: buf.turns.length, memoryIds: writtenIds, ...summary },
      durationMs: Date.now() - startedAt,
    });
    return summary;
  } catch (err) {
    audit({
      category, actor, status: "error", sessionId,
      summary: `${reason} flush failed: ${(err as Error)?.message ?? err}`,
      details: { reason, turns: buf.turns.length, error: String((err as Error)?.message ?? err) },
      durationMs: Date.now() - startedAt,
    });
    throw err; // preserve existing caller behavior
  }
}
