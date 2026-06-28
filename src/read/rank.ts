/**
 * Deterministic ranking (§7 read step 5) — NO second LLM call (frozen §5.10: the one
 * LLM call is spent on planning, ranking is math). Combines similarity, recency decay,
 * stored weight, and per-type priority, then cuts to a token budget.
 */
import type { RecallRow } from "../db/retrieve.js";
import { distanceToSim } from "../match/scorers.js";
import type { Criticality, TaskType } from "./planner.js";
import { isKnowledgeGap } from "./intelligence.js";

// Per-type priority (§11 tunable). Current-state types rank highest.
const TYPE_PRIORITY: Record<string, number> = {
  GOAL: 1.0, CONTEXTUAL: 1.0, PROCEDURAL: 0.9, SEMANTIC: 0.85, EPISODIC: 0.7,
};
const HALF_LIFE_DAYS = 30; // recency decay half-life (§11 tunable)
const DEFAULT_TOKEN_BUDGET = 500;
const EXPLORATION_TOKEN_BUDGET = 300;
const HIGH_CRITICALITY_TOKEN_BUDGET = 800;
const MAX_SELECTED_MEMORIES = 10;
const TASK_CONFIDENCE_THRESHOLD = 0.6;

export interface RankedMemory extends RecallRow { score: number; tokenCost: number }
export interface RankingStats {
  candidateCount: number;
  selectedCount: number;
  selectedTokens: number;
  tokenBudget: number;
  budgetUtilization: number;
  maxMemories: number;
  budgetLimited: boolean;
  backstopTripped: boolean;
}
export interface RankingResult {
  memories: RankedMemory[];
  stats: RankingStats;
}
export interface RankingOptions {
  tokenBudget?: number;
  maxMemories?: number;
  taskType?: TaskType;
  criticality?: Criticality;
  taskConfidence?: number;
}

function recencyDecay(iso: string): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(iso)) / 86_400_000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function confidenceFactor(confidence: number): number {
  if (!Number.isFinite(confidence)) return 1;
  return Math.max(0.25, Math.min(1, confidence));
}

function freshnessFactor(freshness: number): number {
  if (!Number.isFinite(freshness)) return 1;
  return Math.max(0.25, Math.min(1, freshness));
}

function taskPreferenceBoost(row: RecallRow, options: RankingOptions): number {
  if (!hasConfidentTaskInference(options)) return 1;

  switch (options.taskType) {
    case "coding":
      if (row.primaryType === "PROCEDURAL") return row.kind === "antipattern" ? 1.25 : 1.18;
      return 0.98;
    case "learning":
      if (row.primaryType === "EPISODIC") return 1.18;
      if (row.primaryType === "PROCEDURAL") return 1.12;
      return 0.98;
    case "decision":
      if (row.primaryType === "SEMANTIC") return row.hasContradiction ? 1.18 : 1.14;
      if (isKnowledgeGap(row)) return 1.1;
      return 0.98;
    case "debugging":
      if (row.primaryType === "PROCEDURAL") return row.costIfIgnored ? 1.2 : 1.14;
      return 0.98;
    case "design":
      if (row.primaryType === "SEMANTIC") return row.hasContradiction ? 1.2 : 1.15;
      if (isKnowledgeGap(row)) return 1.12;
      return 0.98;
    case "exploration":
      if (isKnowledgeGap(row)) return 1.24;
      if (row.primaryType === "SEMANTIC" && row.confidence < 0.7) return 1.08;
      return 1;
    default:
      return 1;
  }
}

function effectiveSelectionScore(row: RankedMemory, options: RankingOptions): number {
  return row.score * taskPreferenceBoost(row, options);
}

function normalizeOptions(options: number | RankingOptions | undefined): Required<RankingOptions> {
  if (typeof options === "number") {
    return {
      tokenBudget: options,
      maxMemories: MAX_SELECTED_MEMORIES,
      taskType: "coding",
      criticality: "medium",
      taskConfidence: 0,
    };
  }
  return {
    tokenBudget: options?.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    maxMemories: options?.maxMemories ?? MAX_SELECTED_MEMORIES,
    taskType: options?.taskType ?? "coding",
    criticality: options?.criticality ?? "medium",
    taskConfidence: options?.taskConfidence ?? 0,
  };
}

export function hasConfidentTaskInference(options: Pick<RankingOptions, "taskType" | "taskConfidence">): boolean {
  return (options.taskConfidence ?? 0) >= TASK_CONFIDENCE_THRESHOLD;
}

export function adaptiveTokenBudget(options: Pick<RankingOptions, "taskType" | "criticality" | "taskConfidence">): number {
  if (!hasConfidentTaskInference(options)) return DEFAULT_TOKEN_BUDGET;
  if (options.criticality === "high" || options.taskType === "decision") return HIGH_CRITICALITY_TOKEN_BUDGET;
  if (options.criticality === "low" || options.taskType === "exploration") return EXPLORATION_TOKEN_BUDGET;
  return DEFAULT_TOKEN_BUDGET;
}

function shouldApplyHighCriticalityFilter(options: RankingOptions): boolean {
  return hasConfidentTaskInference(options) && options.criticality === "high";
}

export function scoreRow(r: RecallRow): number {
  const sim = r.distance != null ? distanceToSim(r.distance) : 0.7; // direct loads have no distance
  const recency = recencyDecay(r.lastAccessedAt || r.createdAt);
  const weight = Number.isFinite(r.weight) ? r.weight : 1;
  const priority = TYPE_PRIORITY[r.primaryType] ?? 0.8;
  return sim * recency * weight * priority * confidenceFactor(r.confidence) * freshnessFactor(r.freshness);
}

/** Dedup across recall lists by memoryId, score, sort desc, cut to a token budget. */
export function rankMemoriesWithStats(
  lists: RecallRow[][],
  options: number | RankingOptions = DEFAULT_TOKEN_BUDGET,
): RankingResult {
  const normalized = normalizeOptions(options);
  const byId = new Map<string, RecallRow>();
  for (const list of lists) for (const r of list) {
    // keep the row with the smaller distance if duplicated across lists
    const prev = byId.get(r.memoryId);
    if (!prev || (r.distance ?? 9) < (prev.distance ?? 9)) byId.set(r.memoryId, r);
  }

  const ranked = [...byId.values()]
    .filter((row) => !shouldApplyHighCriticalityFilter(normalized) || row.confidence > 0.65)
    .map((r) => ({ ...r, score: scoreRow(r) }))
    .map((r) => ({ ...r, tokenCost: Math.max(1, Math.ceil(r.content.length / 4)) }))
    .sort((a, b) =>
      effectiveSelectionScore(b, normalized) - effectiveSelectionScore(a, normalized) ||
      b.score - a.score,
    );

  const out: RankedMemory[] = [];
  let tokens = 0;
  let budgetLimited = false;
  for (const r of ranked) {
    if (out.length >= normalized.maxMemories) break;
    if (tokens + r.tokenCost > normalized.tokenBudget && out.length > 0) {
      budgetLimited = true;
      break;
    }
    out.push(r);
    tokens += r.tokenCost;
  }
  if (out.length === 0 && ranked[0]) out.push(ranked[0]);
  const selectedTokens = out.reduce((sum, row) => sum + row.tokenCost, 0);
  return {
    memories: out,
    stats: {
      candidateCount: ranked.length,
      selectedCount: out.length,
      selectedTokens,
      tokenBudget: normalized.tokenBudget,
      budgetUtilization: normalized.tokenBudget > 0 ? Math.min(1, selectedTokens / normalized.tokenBudget) : 0,
      maxMemories: normalized.maxMemories,
      budgetLimited,
      backstopTripped: out.length >= normalized.maxMemories && ranked.length > out.length,
    },
  };
}

/** Dedup across recall lists by memoryId, score, sort desc, cut to a token budget. */
export function rankMemories(lists: RecallRow[][], options: number | RankingOptions = DEFAULT_TOKEN_BUDGET): RankedMemory[] {
  return rankMemoriesWithStats(lists, options).memories;
}
