import type { RecallRow } from "../db/retrieve.js";

export interface HeaderAnnotationCounts {
  contradiction_notes: number;
  caution_tags: number;
  gaps_surfaced: number;
}

export interface RelatedGap {
  memoryId: string;
  topic: string;
  priority: string;
}

function tagValue(tags: string[], prefix: string): string | null {
  const match = tags.find((tag) => tag.toLowerCase().startsWith(prefix.toLowerCase()));
  return match ? match.slice(prefix.length).trim() : null;
}

function daysSince(iso: string, nowMs = Date.now()): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((nowMs - ms) / 86_400_000));
}

export function isKnowledgeGap(memory: Pick<RecallRow, "primaryType" | "kind">): boolean {
  return memory.primaryType === "CONTEXTUAL" && memory.kind === "knowledge_gap";
}

export function gapPriority(memory: Pick<RecallRow, "tags">): string {
  return tagValue(memory.tags, "priority:") ?? "low";
}

export function gapPriorityRank(priority: string): number {
  switch (priority) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    default: return 1;
  }
}

export function gapTopic(memory: Pick<RecallRow, "tags" | "content">): string {
  const tagged = tagValue(memory.tags, "gap:");
  if (tagged) return tagged.replace(/-/g, " ");
  const firstLine = memory.content.split("\n")[0] ?? memory.content;
  return firstLine.replace(/^Knowledge gap:\s*/i, "").trim();
}

export function contradictionNote(memory: Pick<RecallRow, "hasContradiction" | "contradictions">): string | null {
  if (!memory.hasContradiction || memory.contradictions.length === 0) return null;
  const note = memory.contradictions[0]?.resolution?.trim();
  return note ? `${note} — weigh by recency` : null;
}

export function cautionAnnotation(memory: Pick<RecallRow, "confidence" | "stalenessFlag" | "lastRevisedAt" | "createdAt">, nowMs = Date.now()): string | null {
  if (memory.confidence >= 0.65 && !memory.stalenessFlag) return null;
  const ageDays = daysSince(memory.lastRevisedAt || memory.createdAt, nowMs);
  return `[low confidence · unconfirmed ${ageDays}d]`;
}

export function splitContextualMemories(rows: RecallRow[]): { contextual: RecallRow[]; gaps: RecallRow[] } {
  const contextual: RecallRow[] = [];
  const gaps: RecallRow[] = [];
  for (const row of rows) {
    if (isKnowledgeGap(row)) gaps.push(row);
    else contextual.push(row);
  }
  return { contextual, gaps };
}

export function selectKnowledgeGaps(gaps: RecallRow[], max = 2): RecallRow[] {
  return [...gaps]
    .filter((gap) => (gap.tags.includes("status:open") || !gap.tags.some((tag) => tag.startsWith("status:"))) && (gap.accessCount ?? 0) < 2)
    .sort((a, b) =>
      gapPriorityRank(gapPriority(b)) - gapPriorityRank(gapPriority(a)) ||
      b.weight - a.weight ||
      b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, max);
}

export function formatGapSummary(gap: Pick<RecallRow, "tags" | "content">): string {
  return `No stated approach to ${gapTopic(gap)} — consider asking`;
}

function normalizedTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

export function relatedGapsForMemory(memory: RecallRow, gaps: RecallRow[]): RelatedGap[] {
  const memoryTerms = new Set([
    ...memory.tags.map((tag) => tag.toLowerCase()),
    ...normalizedTerms(memory.content),
  ]);

  return gaps
    .filter((gap) => {
      if (gap.memoryId === memory.memoryId) return true;
      const topic = gapTopic(gap).toLowerCase();
      if (memoryTerms.has(`gap:${topic.replace(/\s+/g, "-")}`)) return true;
      return normalizedTerms(topic).some((term) => memoryTerms.has(term));
    })
    .sort((a, b) => gapPriorityRank(gapPriority(b)) - gapPriorityRank(gapPriority(a)))
    .slice(0, 3)
    .map((gap) => ({
      memoryId: gap.memoryId,
      topic: gapTopic(gap),
      priority: gapPriority(gap),
    }));
}
