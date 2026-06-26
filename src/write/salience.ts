/**
 * Per-turn salience gate (§7 write step 2). Cheap heuristic, NO LLM. Decides
 * whether a turn is worth buffering for later extraction. Tuned for RECALL — it's
 * a coarse pre-filter; the extraction LLM makes the real keep/drop call per window.
 * Thresholds here are intentionally tunable parameters (§11 salience-gate tuning).
 */
import type { TurnEvent } from "./types.js";

const COMMIT = /\b(decide[ds]?|chose|choosing|will|won't|gonna|going to|let's|need to|should|must|plan(ning)? to|we'll|i'll|agreed?|commit)\b/i;
const PREFERENCE = /\b(prefer|prefers|preferred|like[sd]?|dislike|hate[sd]?|favou?rite|rather|instead of|always|never|by default)\b/i;
const GOAL = /\b(goal|objective|deadline|due|ship|launch|deliver|finish|complete|milestone|trying to|want to|aim(ing)? to)\b/i;
const ASSERTION = /\b(is|are|was|were|means?|equals?|stands for|refers to|consists? of)\b/i;
const NEGATIVE_FILLER = /^(ok(ay)?|yes|yep|no|nope|thanks?|thank you|got it|cool|nice|sure|continue|go on|next|y|n)[.! ]*$/i;

/** A named/identifier-ish token: file paths, CamelCase, snake_case, Capitalized, ALLCAPS. */
const NAMED = /([A-Za-z_][\w./-]*[/._][\w./-]+|[a-z]+[A-Z]\w+|[A-Z][a-zA-Z0-9]{2,}|[A-Z]{2,})/;

export interface SalienceVerdict {
  pass: boolean;
  score: number; // 0..1, monotonic in evidence
  signals: string[];
}

export function salienceGate(turn: TurnEvent): SalienceVerdict {
  const text = turn.text.trim();
  const signals: string[] = [];

  // Tool events are durable by nature (a command was run, a file changed) — keep them.
  if (turn.role === "tool") {
    return { pass: true, score: 0.6, signals: ["tool_action"] };
  }

  // Trivially-empty or pure-acknowledgement turns carry nothing durable.
  if (text.length < 8 || NEGATIVE_FILLER.test(text)) {
    return { pass: false, score: 0, signals: [] };
  }

  const named = NAMED.test(text);
  if (named) signals.push("named_entity");
  if (COMMIT.test(text)) signals.push("commitment");
  if (PREFERENCE.test(text)) signals.push("preference");
  if (GOAL.test(text)) signals.push("goal");
  if (ASSERTION.test(text) && named) signals.push("assertion");

  // Strong signals = anything beyond a bare named-entity mention.
  const strong = signals.filter((s) => s !== "named_entity");
  const score = Math.min(1, strong.length * 0.4 + (named ? 0.3 : 0));
  // Pass if any strong signal, OR a named entity in a reasonably substantive turn.
  const pass = strong.length > 0 || (named && text.length >= 24);

  return { pass, score, signals };
}
