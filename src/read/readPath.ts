/**
 * Read-path orchestrator (§7 read path). Synchronous and must stay fast:
 *   plan (1 LLM call, also emits topic_shifted) → validate entities → parallel recall
 *   → deterministic rank → build push header → reinforce used memories.
 * Returns the header to inject plus topic_shifted for the write-side flush (the spine).
 */
import { planQuery, type QueryPlan } from "./planner.js";
import { adaptiveTokenBudget, hasConfidentTaskInference, rankMemoriesWithStats } from "./rank.js";
import { buildHeader } from "./header.js";
import { recall, relationalFacts, validateEntities } from "../db/retrieve.js";
import { bumpMemories } from "../db/memories.js";
import { embedOne } from "../llm/embed.js";
import { isKnowledgeGap, selectKnowledgeGaps, splitContextualMemories } from "./intelligence.js";

export interface ReadResult {
  header: string; // additionalContext to inject ("" if nothing relevant)
  topicShifted: boolean; // spine signal → drives write-side flush
  usedIds: string[]; // reinforced memories
  debug: {
    entitiesValidated: string[];
    counts: Record<string, number>;
    taskType: string;
    criticality: string;
    taskConfidence: number;
    tokenBudget: number;
    fallbackRanking: boolean;
    readMode: "task-aware" | "naive-fallback";
    naiveFallback: boolean;
    fallbackReason: string | null;
    budgetUsedTokens: number;
    budgetUtilization: number;
    budgetLimited: boolean;
    backstopTripped: boolean;
    headerTokens: number;
    annotations: { contradiction_notes: number; caution_tags: number; gaps_surfaced: number };
  };
}

function defaultPlan(): QueryPlan {
  return {
    entities: [],
    topics: [],
    typesRelevant: ["EPISODIC", "SEMANTIC", "PROCEDURAL", "CONTEXTUAL", "GOAL"],
    timeScope: "all",
    topicShifted: false,
    taskType: "exploration",
    criticality: "medium",
    taskConfidence: 0,
  };
}

function estimatedTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function emptyCounts() {
  return {
    vector: 0,
    bm25: 0,
    goals: 0,
    contextual: 0,
    gaps: 0,
    relFacts: 0,
    injected: 0,
  };
}

export async function readPath(prompt: string, recentContext: string[] = []): Promise<ReadResult> {
  let planned: QueryPlan | null = null;
  let validatedEntities: string[] = [];

  try {
    planned = await planQuery(prompt, recentContext);
    const validated = await validateEntities(planned.entities);
    validatedEntities = validated.map((entity) => entity.name);
    const tokenBudget = adaptiveTokenBudget(planned);
    const queryText = [prompt, ...planned.topics].join(" \n ").slice(0, 2000);
    const queryEmbedding = await embedOne(queryText);
    const [rec, relFacts] = await Promise.all([
      recall({ queryEmbedding, queryText }),
      relationalFacts(validated.map((entity) => entity.entityKey)),
    ]);

    const { contextual, gaps } = splitContextualMemories(rec.contextual);
    const ranking = rankMemoriesWithStats([rec.vector, rec.bm25], {
      tokenBudget,
      taskType: planned.taskType,
      criticality: planned.criticality,
      taskConfidence: planned.taskConfidence,
    });
    const headerMemories = ranking.memories.filter((memory) => !isKnowledgeGap(memory));
    const surfacedGaps = selectKnowledgeGaps([
      ...gaps,
      ...ranking.memories.filter((memory) => isKnowledgeGap(memory) && !gaps.some((gap) => gap.memoryId === memory.memoryId)),
    ]);
    const { text, usedIds, annotations } = buildHeader({
      goals: rec.goals,
      contextual,
      relFacts,
      memories: headerMemories,
      gaps: surfacedGaps,
    });

    if (usedIds.length) void bumpMemories(usedIds).catch(() => {});

    return {
      header: text,
      topicShifted: planned.topicShifted,
      usedIds,
      debug: {
        entitiesValidated: validatedEntities,
        taskType: planned.taskType,
        criticality: planned.criticality,
        taskConfidence: planned.taskConfidence,
        tokenBudget,
        fallbackRanking: !hasConfidentTaskInference(planned),
        readMode: "task-aware",
        naiveFallback: false,
        fallbackReason: null,
        budgetUsedTokens: ranking.stats.selectedTokens,
        budgetUtilization: ranking.stats.budgetUtilization,
        budgetLimited: ranking.stats.budgetLimited,
        backstopTripped: ranking.stats.backstopTripped,
        headerTokens: estimatedTokens(text),
        annotations,
        counts: {
          vector: rec.vector.length,
          bm25: rec.bm25.length,
          goals: rec.goals.length,
          contextual: contextual.length,
          gaps: gaps.length,
          relFacts: relFacts.length,
          injected: usedIds.length,
        },
      },
    };
  } catch (error) {
    const fallbackPlan = defaultPlan();
    const fallbackReason = error instanceof Error ? error.message : String(error);
    try {
      const queryText = prompt.slice(0, 2000);
      const queryEmbedding = await embedOne(queryText);
      const rec = await recall({ queryEmbedding, queryText });
      const { contextual, gaps } = splitContextualMemories(rec.contextual);
      const ranking = rankMemoriesWithStats([rec.vector, rec.bm25], {
        tokenBudget: adaptiveTokenBudget(fallbackPlan),
        taskType: fallbackPlan.taskType,
        criticality: fallbackPlan.criticality,
        taskConfidence: fallbackPlan.taskConfidence,
      });
      const headerMemories = ranking.memories.filter((memory) => !isKnowledgeGap(memory));
      const surfacedGaps = selectKnowledgeGaps([
        ...gaps,
        ...ranking.memories.filter((memory) => isKnowledgeGap(memory) && !gaps.some((gap) => gap.memoryId === memory.memoryId)),
      ]);
      const { text, usedIds, annotations } = buildHeader({
        goals: rec.goals,
        contextual,
        relFacts: [],
        memories: headerMemories,
        gaps: surfacedGaps,
      });

      if (usedIds.length) void bumpMemories(usedIds).catch(() => {});

      return {
        header: text,
        topicShifted: planned?.topicShifted ?? false,
        usedIds,
        debug: {
          entitiesValidated: validatedEntities,
          taskType: fallbackPlan.taskType,
          criticality: fallbackPlan.criticality,
          taskConfidence: fallbackPlan.taskConfidence,
          tokenBudget: adaptiveTokenBudget(fallbackPlan),
          fallbackRanking: true,
          readMode: "naive-fallback",
          naiveFallback: true,
          fallbackReason,
          budgetUsedTokens: ranking.stats.selectedTokens,
          budgetUtilization: ranking.stats.budgetUtilization,
          budgetLimited: ranking.stats.budgetLimited,
          backstopTripped: ranking.stats.backstopTripped,
          headerTokens: estimatedTokens(text),
          annotations,
          counts: {
            vector: rec.vector.length,
            bm25: rec.bm25.length,
            goals: rec.goals.length,
            contextual: contextual.length,
            gaps: gaps.length,
            relFacts: 0,
            injected: usedIds.length,
          },
        },
      };
    } catch (fallbackError) {
      const combinedReason = `${fallbackReason}; fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
      return {
        header: "",
        topicShifted: planned?.topicShifted ?? false,
        usedIds: [],
        debug: {
          entitiesValidated: validatedEntities,
          taskType: fallbackPlan.taskType,
          criticality: fallbackPlan.criticality,
          taskConfidence: fallbackPlan.taskConfidence,
          tokenBudget: adaptiveTokenBudget(fallbackPlan),
          fallbackRanking: true,
          readMode: "naive-fallback",
          naiveFallback: true,
          fallbackReason: combinedReason,
          budgetUsedTokens: 0,
          budgetUtilization: 0,
          budgetLimited: false,
          backstopTripped: false,
          headerTokens: 0,
          annotations: { contradiction_notes: 0, caution_tags: 0, gaps_surfaced: 0 },
          counts: emptyCounts(),
        },
      };
    }
  }
}
