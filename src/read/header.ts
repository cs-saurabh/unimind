/**
 * Push-header builder (§5.9, §7 read step 6). A small, high-confidence block injected
 * via UserPromptSubmit additionalContext: active goals + current contextual state +
 * relational facts on named entities + the top-ranked relevant memories. Deeper digs
 * are left to the recall() tool (step 6). Kept tight to avoid polluting context.
 */
import type { RankedMemory } from "./rank.js";
import type { RecallRow, RelFact } from "../db/retrieve.js";

export interface HeaderParts {
  goals: RecallRow[];
  contextual: RecallRow[];
  relFacts: RelFact[];
  memories: RankedMemory[];
}

export function buildHeader(parts: HeaderParts): { text: string; usedIds: string[] } {
  const lines: string[] = [];
  const usedIds: string[] = [];

  if (parts.goals.length) {
    lines.push("Active goals:");
    for (const g of parts.goals.slice(0, 5)) { lines.push(`- ${g.content}`); usedIds.push(g.memoryId); }
  }
  if (parts.contextual.length) {
    lines.push("Current state:");
    for (const c of parts.contextual.slice(0, 5)) { lines.push(`- ${c.content}`); usedIds.push(c.memoryId); }
  }
  if (parts.relFacts.length) {
    lines.push("Known relationships:");
    for (const f of parts.relFacts.slice(0, 8)) lines.push(`- ${f.subject} ${f.predicate} ${f.object}`);
  }
  if (parts.memories.length) {
    lines.push("Relevant memories:");
    for (const m of parts.memories) { lines.push(`- ${m.content}`); usedIds.push(m.memoryId); }
  }

  if (lines.length === 0) return { text: "", usedIds: [] };
  const text = `<unimind-memory>\n${lines.join("\n")}\n</unimind-memory>`;
  return { text, usedIds: [...new Set(usedIds)] };
}
