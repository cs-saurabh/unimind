/**
 * recall(query) — the explicit "pull" half of retrieval (§5.9). The push header is
 * tiny and high-confidence; recall() is the deeper, query-driven dig Claude invokes
 * when it wants more. Returns ranked memories and reinforces what it surfaces (§5.11).
 */
import { recall as recallDb } from "../db/retrieve.js";
import { rankMemories } from "./rank.js";
import { bumpMemories } from "../db/memories.js";
import { embedOne } from "../llm/embed.js";

export interface RecalledMemory {
  content: string;
  primaryType: string;
  score: number;
}

export async function recall(query: string, limit = 8): Promise<RecalledMemory[]> {
  const queryEmbedding = await embedOne(query);
  const rec = await recallDb({ queryEmbedding, queryText: query, k: Math.max(limit * 2, 16) });

  // Rank the semantic/episodic/procedural recall with a generous budget; fold in
  // any active goals/contextual state as always-relevant context.
  const ranked = rankMemories([rec.vector, rec.bm25, rec.goals, rec.contextual], limit * 120).slice(0, limit);

  if (ranked.length) void bumpMemories(ranked.map((m) => m.memoryId)).catch(() => {});
  return ranked.map((m) => ({ content: m.content, primaryType: m.primaryType, score: +m.score.toFixed(3) }));
}
