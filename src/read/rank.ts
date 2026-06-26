/**
 * Deterministic ranking (§7 read step 5) — NO second LLM call (frozen §5.10: the one
 * LLM call is spent on planning, ranking is math). Combines similarity, recency decay,
 * stored weight, and per-type priority, then cuts to a token budget.
 */
import type { RecallRow } from "../db/retrieve.js";
import { distanceToSim } from "../match/scorers.js";
import type { PrimaryType } from "../db/schema.js";

// Per-type priority (§11 tunable). Current-state types rank highest.
const TYPE_PRIORITY: Record<string, number> = {
  GOAL: 1.0, CONTEXTUAL: 1.0, PROCEDURAL: 0.9, SEMANTIC: 0.85, EPISODIC: 0.7,
};
const HALF_LIFE_DAYS = 30; // recency decay half-life (§11 tunable)

export interface RankedMemory extends RecallRow { score: number }

function recencyDecay(iso: string): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(iso)) / 86_400_000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

export function scoreRow(r: RecallRow): number {
  const sim = r.distance != null ? distanceToSim(r.distance) : 0.7; // direct loads have no distance
  const recency = recencyDecay(r.lastAccessedAt || r.createdAt);
  const weight = Number.isFinite(r.weight) ? r.weight : 1;
  const priority = TYPE_PRIORITY[r.primaryType] ?? 0.8;
  return sim * recency * weight * priority;
}

/** Dedup across recall lists by memoryId, score, sort desc, cut to a token budget. */
export function rankMemories(lists: RecallRow[][], tokenBudget = 500): RankedMemory[] {
  const byId = new Map<string, RecallRow>();
  for (const list of lists) for (const r of list) {
    // keep the row with the smaller distance if duplicated across lists
    const prev = byId.get(r.memoryId);
    if (!prev || (r.distance ?? 9) < (prev.distance ?? 9)) byId.set(r.memoryId, r);
  }
  const ranked = [...byId.values()]
    .map((r) => ({ ...r, score: scoreRow(r) }))
    .sort((a, b) => b.score - a.score);

  const out: RankedMemory[] = [];
  let tokens = 0;
  for (const r of ranked) {
    const cost = Math.ceil(r.content.length / 4);
    if (tokens + cost > tokenBudget) break;
    out.push(r);
    tokens += cost;
  }
  return out;
}
