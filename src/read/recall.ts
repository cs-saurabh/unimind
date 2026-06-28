/**
 * recall(query) — the explicit "pull" half of retrieval (§5.9). The push header is
 * tiny and high-confidence; recall() is the deeper, query-driven dig Claude invokes
 * when it wants more. Returns ranked memories and reinforces what it surfaces (§5.11).
 */
import { recall as recallDb } from "../db/retrieve.js";
import { adaptiveTokenBudget, rankMemoriesWithStats } from "./rank.js";
import { bumpMemories } from "../db/memories.js";
import { embedOne } from "../llm/embed.js";
import { planQuery, type QueryPlan } from "./planner.js";
import { cautionAnnotation, contradictionNote, relatedGapsForMemory, splitContextualMemories } from "./intelligence.js";

export interface RecalledMemory {
  memoryId: string;
  type: string;
  kind: string | null;
  text: string;
  score: number;
  metadata: {
    confidence: number;
    freshness: number;
    basis: string;
    derivedFrom: string[];
    costIfIgnored: string | null;
    lastValidated: string;
    stalenessFlag: string | null;
  };
  contradictions: Array<{
    withMemoryId: string;
    resolution: string;
    confidence: number;
    resolvedAt: string;
  }>;
  relatedGaps: Array<{ memoryId: string; topic: string; priority: string }>;
}

export interface RecallResult {
  memories: RecalledMemory[];
  meta: {
    taskType: string;
    criticality: string;
    taskConfidence: number;
    tokenBudget: number;
    readMode: "task-aware" | "naive-fallback";
    naiveFallback: boolean;
    fallbackReason: string | null;
    budgetUsedTokens: number;
    budgetUtilization: number;
    budgetLimited: boolean;
    backstopTripped: boolean;
    annotations: {
      contradiction_notes: number;
      caution_tags: number;
      gaps_surfaced: number;
    };
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

export async function recall(query: string, limit = 8): Promise<RecallResult> {
  async function execute(plan: QueryPlan, mode: "task-aware" | "naive-fallback", fallbackReason: string | null) {
    const tokenBudget = adaptiveTokenBudget(plan);
    const queryText = [query, ...plan.topics].join(" \n ").slice(0, 2000);
    const queryEmbedding = await embedOne(queryText);
    const rec = await recallDb({ queryEmbedding, queryText, k: Math.max(limit * 2, 16) });
    const { contextual, gaps } = splitContextualMemories(rec.contextual);

    const rankedResult = rankMemoriesWithStats([rec.vector, rec.bm25, rec.goals, contextual, gaps], {
      tokenBudget,
      taskType: plan.taskType,
      criticality: plan.criticality,
      taskConfidence: plan.taskConfidence,
    });
    const ranked = rankedResult.memories.slice(0, limit);

    if (ranked.length) void bumpMemories(ranked.map((m) => m.memoryId)).catch(() => {});
    const annotations = ranked.reduce((acc, memory) => {
      if (contradictionNote(memory)) acc.contradiction_notes++;
      if (cautionAnnotation(memory)) acc.caution_tags++;
      if (memory.kind === "knowledge_gap") acc.gaps_surfaced++;
      return acc;
    }, {
      contradiction_notes: 0,
      caution_tags: 0,
      gaps_surfaced: 0,
    });

    return {
      memories: ranked.map((m) => ({
        memoryId: m.memoryId,
        type: m.primaryType,
        kind: m.kind ?? null,
        text: m.content,
        score: +m.score.toFixed(3),
        metadata: {
          confidence: +m.confidence.toFixed(3),
          freshness: +m.freshness.toFixed(3),
          basis: m.basis,
          derivedFrom: m.derivedFrom,
          costIfIgnored: m.costIfIgnored,
          lastValidated: m.lastRevisedAt,
          stalenessFlag: m.stalenessFlag,
        },
        contradictions: m.contradictions,
        relatedGaps: relatedGapsForMemory(m, gaps),
      })),
      meta: {
        taskType: plan.taskType,
        criticality: plan.criticality,
        taskConfidence: plan.taskConfidence,
        tokenBudget,
        readMode: mode,
        naiveFallback: mode === "naive-fallback",
        fallbackReason,
        budgetUsedTokens: rankedResult.stats.selectedTokens,
        budgetUtilization: rankedResult.stats.budgetUtilization,
        budgetLimited: rankedResult.stats.budgetLimited,
        backstopTripped: rankedResult.stats.backstopTripped,
        annotations,
      },
    };
  }

  try {
    const plan = await planQuery(query);
    return await execute(plan, "task-aware", null);
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : String(error);
    return execute(defaultPlan(), "naive-fallback", fallbackReason);
  }
}
