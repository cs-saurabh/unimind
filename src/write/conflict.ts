/**
 * Conflict dispatch (§4 / §7 write step 6) — replaces naive ADD. Uses the §5.7
 * matching engine to classify the relationship between a candidate memory and the
 * nearest CURRENT memories of the same type, then applies a per-type policy:
 *
 *   EPISODIC    immutable, ADD-only; only a literal duplicate is skipped
 *   SEMANTIC    conflicts are suspicious — never destroy on first contradiction; EXTEND
 *   PROCEDURAL  merge/version — a contradiction supersedes
 *   CONTEXTUAL  latest-wins — any close match is hard-superseded
 *   GOAL        duplicate skipped; correction supersedes
 *
 * Supersede never destroys (except contextual hard-delete) — §5.6.
 */
import { match } from "../match/engine.js";
import { distanceToSim } from "../match/scorers.js";
import { jsonComplete } from "../llm/complete.js";
import { similarMemories } from "../db/retrieve.js";
import type { RecallRow } from "../db/retrieve.js";
import type { CandidateMemory } from "./types.js";
import type { PrimaryType } from "../db/schema.js";

export type Relationship = "duplicate" | "update" | "extend" | "unrelated";

export type WriteAction =
  | { kind: "add" } // create standalone
  | { kind: "skip"; targetId: string } // duplicate → reinforce target, don't create
  | { kind: "extend"; targetId: string } // create + EXTENDS old
  | { kind: "supersede"; targetId: string; hardDelete: boolean }; // create + UPDATES old

const HIGH = 0.9; // ≥ → confident near-duplicate, no LLM
const LOW = 0.6; // < → confidently unrelated, no LLM

// (relationship, type) → action. Encodes §4 conflict semantics.
function policy(rel: Relationship, type: PrimaryType, targetId: string): WriteAction {
  if (rel === "unrelated") return { kind: "add" };
  if (rel === "duplicate") return { kind: "skip", targetId };
  switch (type) {
    case "EPISODIC": // immutable; updates/extensions are still new events
      return { kind: "add" };
    case "SEMANTIC": // never destroy on contradiction — keep both, link
      return { kind: "extend", targetId };
    case "PROCEDURAL":
      return rel === "update" ? { kind: "supersede", targetId, hardDelete: false } : { kind: "extend", targetId };
    case "CONTEXTUAL": // latest-wins, hard-delete the stale state
      return { kind: "supersede", targetId, hardDelete: true };
    case "GOAL":
      return rel === "update" ? { kind: "supersede", targetId, hardDelete: false } : { kind: "extend", targetId };
  }
}

export async function resolveConflict(candidate: CandidateMemory, embedding: number[]): Promise<WriteAction> {
  const outcome = await match<CandidateMemory, RecallRow, { relationship: Relationship; targetIndex: number | null }>(
    candidate,
    {
      block: () => similarMemories(embedding, candidate.primaryType, 5),
      score: (_c, row) => (row.distance != null ? distanceToSim(row.distance) : 0),
      high: HIGH,
      low: LOW,
      grayLimit: 5,
      adjudicate: async (c, gray) => {
        const options = gray.map((s, i) => `${i}. ${s.candidate.content}`).join("\n");
        const res = await jsonComplete<{ relationship: Relationship; targetIndex: number | null }>({
          system: `You compare a NEW memory against EXISTING memories of the same kind and classify
their relationship as json {"relationship": "...", "targetIndex": <n|null>}:
- "duplicate": the new memory states the same durable fact as an existing one.
- "update": the new memory corrects or contradicts an existing one (pick its index).
- "extend": the new memory adds detail to an existing one without replacing it (pick its index).
- "unrelated": none of the existing memories is about the same thing.
targetIndex is the existing memory index it relates to, or null for unrelated.`,
          user: `NEW: ${c.content}\n\nEXISTING:\n${options}`,
        });
        return res;
      },
    },
  );

  if (outcome.band === "no_match" || !outcome.top) return { kind: "add" };
  if (outcome.band === "match") return policy("duplicate", candidate.primaryType, outcome.top.candidate.memoryId);

  // gray: LLM classified
  const adj = outcome.adjudication;
  if (!adj || adj.relationship === "unrelated") return { kind: "add" };
  const idx = adj.targetIndex;
  const target = typeof idx === "number" && idx >= 0 && idx < outcome.scored.length
    ? outcome.scored[idx].candidate
    : outcome.top.candidate;
  return policy(adj.relationship, candidate.primaryType, target.memoryId);
}
