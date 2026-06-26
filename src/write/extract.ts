/**
 * Extraction worker (§7 write step 4). ONE LLM call over the whole buffered window
 * (never a lone turn). Returns self-contained, entity-centric candidate memories
 * plus coreference-resolved mention clusters. Follows the helix-memory-system
 * contextual-extraction rules: resolve pronouns/ellipsis, treat short answers as
 * candidates, type each memory, attach a relational triple when present.
 */
import type { SessionBuffer, ExtractionResult, CandidateMemory, MentionCluster } from "./types.js";
import { jsonComplete, HOT_MODEL } from "../llm/complete.js";

const SYSTEM = `You extract durable long-term MEMORIES from a window of a coding-assistant session.
Read the WHOLE window; resolve pronouns, ellipsis, and short follow-up answers into
self-contained statements before deciding. Extract only durable, meaningful facts — skip
chit-chat, transient tool output, and anything not worth remembering across sessions.

Classify each memory's primaryType:
- EPISODIC: a time-bound, person/event-specific occurrence ("X asked about Y on <date>").
- SEMANTIC: a general fact/definition/rule that stays true.
- PROCEDURAL: a how-to, learned technique, or best practice.
- CONTEXTUAL: current-session state (active task, what's in progress) — short-lived.
- GOAL: an active goal/plan, possibly with a deadline or success criteria.

Also return the distinct real-world ENTITIES mentioned (people, orgs, projects, concepts),
each with its best canonical name, type, and every surface form seen in the window.
Each memory references entities by their index in the clusters array (mentionRefs).
If a memory is fundamentally a relationship between two entities, fill "relation"
{subjectRef, predicate, objectRef} (predicate is a short verb phrase like "leads", "uses").

Return STRICT JSON:
{
 "clusters": [{"canonicalName": "...", "entityType": "person|org|project|concept", "surfaceForms": ["..."]}],
 "memories": [{
   "content": "self-contained statement",
   "primaryType": "SEMANTIC",
   "tags": ["..."],
   "confidence": 0.0-1.0,
   "salience": 0.0-1.0,
   "mentionRefs": [0],
   "relation": {"subjectRef":0,"predicate":"leads","objectRef":1} | null,
   "temporalText": "next April" | null
 }]
}
If nothing is worth storing, return {"clusters":[],"memories":[]}.`;

function renderWindow(buf: SessionBuffer): string {
  const head = buf.project ? `Project: ${buf.project}\n` : "";
  const body = buf.turns
    .map((t) => `[${t.role}${t.toolName ? `:${t.toolName}` : ""}] ${t.text.replace(/\s+/g, " ").slice(0, 800)}`)
    .join("\n");
  return `${head}Window (${buf.turns.length} turns):\n${body}`;
}

const TYPES = new Set(["EPISODIC", "SEMANTIC", "PROCEDURAL", "CONTEXTUAL", "GOAL"]);
const ENT_TYPES = new Set(["person", "org", "project", "concept"]);

export async function extractWindow(buf: SessionBuffer, model = HOT_MODEL): Promise<ExtractionResult> {
  if (buf.turns.length === 0) return { memories: [], clusters: [] };
  const raw = await jsonComplete<any>({
    system: SYSTEM,
    user: renderWindow(buf),
    model,
    maxTokens: 1500,
  });

  // Validate/normalize defensively — the LLM output drives deterministic writes.
  const clusters: MentionCluster[] = (raw.clusters ?? [])
    .filter((c: any) => c && typeof c.canonicalName === "string" && ENT_TYPES.has(c.entityType))
    .map((c: any) => ({
      canonicalName: c.canonicalName.trim(),
      entityType: c.entityType,
      surfaceForms: Array.isArray(c.surfaceForms) && c.surfaceForms.length
        ? [...new Set(c.surfaceForms.map((s: any) => String(s).trim()).filter(Boolean))]
        : [c.canonicalName.trim()],
    }));

  const n = clusters.length;
  const validRef = (i: any) => Number.isInteger(i) && i >= 0 && i < n;

  const memories: CandidateMemory[] = (raw.memories ?? [])
    .filter((m: any) => m && typeof m.content === "string" && m.content.trim() && TYPES.has(m.primaryType))
    .map((m: any) => {
      const rel = m.relation && validRef(m.relation.subjectRef) && validRef(m.relation.objectRef) &&
        typeof m.relation.predicate === "string"
        ? { subjectRef: m.relation.subjectRef, predicate: m.relation.predicate.trim(), objectRef: m.relation.objectRef }
        : null;
      return {
        content: m.content.trim(),
        primaryType: m.primaryType,
        tags: Array.isArray(m.tags) ? m.tags.map((t: any) => String(t)).slice(0, 8) : [],
        confidence: clamp01(m.confidence, 0.6),
        salience: clamp01(m.salience, 0.5),
        mentionRefs: Array.isArray(m.mentionRefs) ? m.mentionRefs.filter(validRef) : [],
        relation: rel,
        temporalText: typeof m.temporalText === "string" ? m.temporalText : null,
      };
    });

  return { memories, clusters };
}

function clamp01(v: any, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}
