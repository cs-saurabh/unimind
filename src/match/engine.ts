/**
 * Reusable matching engine (handoff §5.7). One skeleton powers three jobs:
 * entity linking, conflict resolution, and read-path entity validation.
 *
 *   block   — cheap candidate fetch (indexed lookup / vector / BM25)
 *   score   — deterministic similarity, 0..1 (no LLM)
 *   threshold — high/low bands decide CONFIDENTLY without an LLM
 *   adjudicate — an LLM call runs ONLY on the gray band, on a capped candidate set
 *
 * The engine is domain-agnostic: each job supplies its own block/score/adjudicate
 * and interprets the outcome. The whole point is to spend the LLM call only on
 * genuine ambiguity — confident matches and confident misses never touch it.
 */

export interface Scored<C> {
  candidate: C;
  score: number; // 0..1, higher = more similar
}

export type Band = "match" | "gray" | "no_match";

export interface MatchOutcome<C, A> {
  band: Band;
  scored: Scored<C>[]; // all candidates, sorted by score desc
  top: Scored<C> | null;
  adjudication: A | null; // present iff the gray band ran the adjudicator
  usedLLM: boolean;
}

export interface MatchConfig<I, C, A = unknown> {
  /** Cheap candidate fetch. Return [] when nothing plausible exists. */
  block: (input: I) => Promise<C[]> | C[];
  /** Deterministic similarity in [0,1]. Higher = more similar. */
  score: (input: I, candidate: C) => number;
  /** top.score >= high  → confident "match" (no LLM). */
  high: number;
  /** top.score <  low   → confident "no_match" (no LLM). */
  low: number;
  /** Max candidates handed to the adjudicator (LLM cost guard). Default 5. */
  grayLimit?: number;
  /** LLM adjudication, invoked ONLY when the top score lands in the gray band. */
  adjudicate?: (input: I, gray: Scored<C>[]) => Promise<A>;
}

export async function match<I, C, A = unknown>(
  input: I,
  cfg: MatchConfig<I, C, A>,
): Promise<MatchOutcome<C, A>> {
  if (cfg.high < cfg.low) {
    throw new Error(`match: high (${cfg.high}) must be >= low (${cfg.low})`);
  }

  const candidates = await cfg.block(input);
  const scored: Scored<C>[] = candidates
    .map((candidate) => ({ candidate, score: cfg.score(input, candidate) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0] ?? null;

  // No candidates, or the best is below the low threshold → confident miss.
  if (!top || top.score < cfg.low) {
    return { band: "no_match", scored, top, adjudication: null, usedLLM: false };
  }

  // Best is at/above the high threshold → confident match, deterministic.
  if (top.score >= cfg.high) {
    return { band: "match", scored, top, adjudication: null, usedLLM: false };
  }

  // Gray band: spend the LLM call, on a capped candidate set.
  if (cfg.adjudicate) {
    const gray = scored.slice(0, cfg.grayLimit ?? 5);
    const adjudication = await cfg.adjudicate(input, gray);
    return { band: "gray", scored, top, adjudication, usedLLM: true };
  }

  // Gray band with no adjudicator configured — surface it for the caller to decide.
  return { band: "gray", scored, top, adjudication: null, usedLLM: false };
}
