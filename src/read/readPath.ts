/**
 * Read-path orchestrator (§7 read path). Synchronous and must stay fast:
 *   plan (1 LLM call, also emits topic_shifted) → validate entities → parallel recall
 *   → deterministic rank → build push header → reinforce used memories.
 * Returns the header to inject plus topic_shifted for the write-side flush (the spine).
 */
import { planQuery } from "./planner.js";
import { rankMemories } from "./rank.js";
import { buildHeader } from "./header.js";
import { recall, relationalFacts, validateEntities } from "../db/retrieve.js";
import { bumpMemories } from "../db/memories.js";
import { embedOne } from "../llm/embed.js";

export interface ReadResult {
  header: string; // additionalContext to inject ("" if nothing relevant)
  topicShifted: boolean; // spine signal → drives write-side flush
  usedIds: string[]; // reinforced memories
  debug: { entitiesValidated: string[]; counts: Record<string, number> };
}

export async function readPath(prompt: string, recentContext: string[] = []): Promise<ReadResult> {
  const plan = await planQuery(prompt, recentContext);

  // Embed the query (prompt + planned topics) for vector recall.
  const queryText = [prompt, ...plan.topics].join(" \n ").slice(0, 2000);
  const [queryEmbedding, validated] = await Promise.all([
    embedOne(queryText),
    validateEntities(plan.entities),
  ]);

  // Parallel retrieval (§7 read step 4).
  const [rec, relFacts] = await Promise.all([
    recall({ queryEmbedding, queryText }),
    relationalFacts(validated.map((e) => e.entityKey)),
  ]);

  // Rank semantic/episodic/procedural recall; goals + contextual go straight to the header.
  const memories = rankMemories([rec.vector, rec.bm25], 500);
  const { text, usedIds } = buildHeader({
    goals: rec.goals, contextual: rec.contextual, relFacts, memories,
  });

  // Reinforce on retrieval (fire-and-forget; never block the read).
  if (usedIds.length) void bumpMemories(usedIds).catch(() => {});

  return {
    header: text,
    topicShifted: plan.topicShifted,
    usedIds,
    debug: {
      entitiesValidated: validated.map((e) => e.name),
      counts: {
        vector: rec.vector.length, bm25: rec.bm25.length, goals: rec.goals.length,
        contextual: rec.contextual.length, relFacts: relFacts.length, injected: usedIds.length,
      },
    },
  };
}
