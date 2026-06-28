/**
 * Push-header builder (§5.9, §7 read step 6). A small, high-confidence block injected
 * via UserPromptSubmit additionalContext: active goals + current contextual state +
 * relational facts on named entities + the top-ranked relevant memories. Deeper digs
 * are left to the recall() tool (step 6). Kept tight to avoid polluting context.
 */
import type { RankedMemory } from "./rank.js";
import type { RecallRow, RelFact } from "../db/retrieve.js";
import {
  cautionAnnotation,
  contradictionNote,
  formatGapSummary,
  type HeaderAnnotationCounts,
} from "./intelligence.js";

export interface HeaderParts {
  goals: RecallRow[];
  contextual: RecallRow[];
  relFacts: RelFact[];
  memories: RankedMemory[];
  gaps: RecallRow[];
}

function renderMemoryLine(memory: RecallRow, nowMs = Date.now()): { line: string; contradiction: boolean; caution: boolean } {
  const note = contradictionNote(memory);
  const caution = cautionAnnotation(memory, nowMs);
  let line = `- ${memory.content}`;
  if (note) line += `  ⚠ ${note}`;
  if (caution) line += `  ${caution}`;
  return { line, contradiction: Boolean(note), caution: Boolean(caution) };
}

function emptyAnnotations(): HeaderAnnotationCounts {
  return {
    contradiction_notes: 0,
    caution_tags: 0,
    gaps_surfaced: 0,
  };
}

export function buildHeader(parts: HeaderParts): { text: string; usedIds: string[]; annotations: HeaderAnnotationCounts } {
  const lines: string[] = [];
  const usedIds: string[] = [];
  const annotations = emptyAnnotations();
  const nowMs = Date.now();

  if (parts.goals.length) {
    lines.push("Active goals:");
    for (const g of parts.goals.slice(0, 5)) {
      const rendered = renderMemoryLine(g, nowMs);
      lines.push(rendered.line);
      if (rendered.contradiction) annotations.contradiction_notes++;
      if (rendered.caution) annotations.caution_tags++;
      usedIds.push(g.memoryId);
    }
  }
  if (parts.contextual.length) {
    lines.push("Current state:");
    for (const c of parts.contextual.slice(0, 5)) {
      const rendered = renderMemoryLine(c, nowMs);
      lines.push(rendered.line);
      if (rendered.contradiction) annotations.contradiction_notes++;
      if (rendered.caution) annotations.caution_tags++;
      usedIds.push(c.memoryId);
    }
  }
  if (parts.relFacts.length) {
    lines.push("Known relationships:");
    for (const f of parts.relFacts.slice(0, 8)) lines.push(`- ${f.subject} ${f.predicate} ${f.object}`);
  }
  if (parts.memories.length) {
    lines.push("Relevant memories:");
    for (const m of parts.memories) {
      const rendered = renderMemoryLine(m, nowMs);
      lines.push(rendered.line);
      if (rendered.contradiction) annotations.contradiction_notes++;
      if (rendered.caution) annotations.caution_tags++;
      usedIds.push(m.memoryId);
    }
  }
  if (parts.gaps.length) {
    lines.push("Knowledge gaps:");
    for (const gap of parts.gaps) {
      lines.push(`- ${formatGapSummary(gap)}`);
      usedIds.push(gap.memoryId);
      annotations.gaps_surfaced++;
    }
  }

  if (lines.length === 0) return { text: "", usedIds: [], annotations };
  const text = `<unimind-memory>\n${lines.join("\n")}\n</unimind-memory>`;
  return { text, usedIds: [...new Set(usedIds)], annotations };
}
