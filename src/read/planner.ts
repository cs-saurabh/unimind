/**
 * Read-path query planner + shift detector (§5.10, §5.12, §7 read step 3). ONE cheap
 * LLM call turns the prompt + recent context into a retrieval plan AND the spine's
 * topic_shifted flag. Spending the call on PLANNING (not re-ranking) is the frozen
 * §5.10 decision: a planner that sees "Sarah" + "Q4" can direct the right traversal,
 * which a blind embedding of the prompt cannot.
 */
import type { PrimaryType } from "../db/schema.js";
import { jsonComplete, HOT_MODEL } from "../llm/complete.js";

export interface QueryPlan {
  entities: string[]; // named entities to validate + traverse from
  topics: string[]; // free-text topics for semantic/BM25 recall
  typesRelevant: PrimaryType[]; // which memory types matter for this prompt
  timeScope: "recent" | "all" | "none";
  topicShifted: boolean; // spine signal: did the topic change vs the running context?
}

const ALL_TYPES: PrimaryType[] = ["EPISODIC", "SEMANTIC", "PROCEDURAL", "CONTEXTUAL", "GOAL"];

const SYSTEM = `You plan memory retrieval for a coding assistant. Given the RUNNING CONTEXT
(recent turns) and the USER'S NEW PROMPT, output a compact retrieval plan as json.

Fields:
- entities: proper-noun entities named or clearly implied by the prompt (people, orgs,
  projects, files, concepts). Names only, no descriptions. [] if none.
- topics: 1-4 short topic phrases to search memory for semantically.
- typesRelevant: which memory types help here, from
  ["EPISODIC","SEMANTIC","PROCEDURAL","CONTEXTUAL","GOAL"].
- timeScope: "recent" (latest state matters), "all" (any time), or "none".
- topicShifted: true if the new prompt is a substantial shift to a different topic/task
  from the running context (new subject/files/goal or an abrupt pivot); false for a
  follow-up, refinement, or continuation. When unsure, false.

Return strict json with exactly these fields.`;

export async function planQuery(prompt: string, recentContext: string[] = [], model = HOT_MODEL): Promise<QueryPlan> {
  const ctx = recentContext.slice(-6).map((t) => `- ${t.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") || "(none)";
  const raw = await jsonComplete<any>({
    system: SYSTEM,
    user: `RUNNING CONTEXT:\n${ctx}\n\nNEW PROMPT:\n${prompt.slice(0, 1000)}`,
    model,
    maxTokens: 300,
  });

  const arr = (v: any): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const types = arr(raw.typesRelevant).filter((t) => (ALL_TYPES as string[]).includes(t)) as PrimaryType[];
  return {
    entities: [...new Set(arr(raw.entities))].slice(0, 8),
    topics: arr(raw.topics).slice(0, 4),
    typesRelevant: types.length ? types : ALL_TYPES,
    timeScope: ["recent", "all", "none"].includes(raw.timeScope) ? raw.timeScope : "all",
    topicShifted: raw.topicShifted === true,
  };
}
