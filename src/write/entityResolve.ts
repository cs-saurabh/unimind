/**
 * Entity resolution (§7 write step 5) via the reusable matching engine (§5.7).
 * For each in-window mention cluster: block (vector+BM25 candidates) → score
 * (alias string sim + embedding sim) → threshold → LLM adjudication only on the
 * gray band. Biases UNDER-merge (§5.8): high auto-merge bar, and the adjudicator
 * defaults to "new node" when unsure — a missed merge is repairable, a wrong merge
 * is not.
 */
import { match } from "../match/engine.js";
import { bestAliasSim, combine } from "../match/scorers.js";
import { jsonComplete } from "../llm/complete.js";
import { searchEntityCandidates, createEntity, addAliases, type EntityCandidate } from "../db/entities.js";
import type { MentionCluster } from "./types.js";

// Under-merge bias: only auto-link when very confident; everything plausible-but-uncertain
// goes to the adjudicator, which itself defaults to creating a new node.
const HIGH = 0.86;
const LOW = 0.55;

export interface ResolveResult {
  entityKey: string;
  action: "linked" | "created";
  usedLLM: boolean;
}

interface ResolveInput {
  cluster: MentionCluster;
  embedding: number[];
}

function scoreCandidate(input: ResolveInput, c: EntityCandidate): number {
  const surfaces = [c.name, ...c.aliases];
  const queryForms = [input.cluster.canonicalName, ...input.cluster.surfaceForms];
  const aliasSim = Math.max(...queryForms.map((q) => bestAliasSim(q, surfaces)));
  return combine([
    { score: aliasSim, weight: 0.6 },
    { score: c.vectorSim ?? 0, weight: 0.4 },
  ]);
}

export async function resolveEntity(cluster: MentionCluster, embedding: number[]): Promise<ResolveResult> {
  const input: ResolveInput = { cluster, embedding };

  const outcome = await match<ResolveInput, EntityCandidate, { entityKey: string | null }>(input, {
    block: () => searchEntityCandidates(cluster.canonicalName, embedding),
    score: scoreCandidate,
    high: HIGH,
    low: LOW,
    grayLimit: 5,
    adjudicate: async (inp, gray) => {
      const options = gray.map((s, i) =>
        `${i}. ${s.candidate.name} (aliases: ${s.candidate.aliases.join(", ") || "—"}) [sim ${s.score.toFixed(2)}]`,
      ).join("\n");
      const res = await jsonComplete<{ index: number | null }>({
        system: `You decide whether a newly-mentioned entity is the SAME real-world thing as an existing one.
Bias strongly toward "none": only pick an existing entity if you are confident it is literally the
same person/org/project/concept. Different people who share a first name are NOT the same. When in
doubt, answer none — a missed link is cheaply repaired later, a wrong merge is not.
Return {"index": <number of the matching option, or null>}.`,
        user: `New mention: "${inp.cluster.canonicalName}" (type ${inp.cluster.entityType}; forms: ${inp.cluster.surfaceForms.join(", ")})
Existing candidates:\n${options}\n\nWhich existing candidate is the SAME entity, if any?`,
      });
      const idx = res.index;
      const chosen = typeof idx === "number" && idx >= 0 && idx < gray.length ? gray[idx].candidate : null;
      return { entityKey: chosen?.entityKey ?? null };
    },
  });

  // Confident match → link.
  if (outcome.band === "match" && outcome.top) {
    await addAliases(outcome.top.candidate.entityKey, outcome.top.candidate.aliases, cluster.surfaceForms);
    return { entityKey: outcome.top.candidate.entityKey, action: "linked", usedLLM: false };
  }
  // Gray → adjudicator decided (may have linked, else falls through to create).
  if (outcome.band === "gray" && outcome.adjudication?.entityKey) {
    const c = outcome.scored.find((s) => s.candidate.entityKey === outcome.adjudication!.entityKey)?.candidate;
    if (c) {
      await addAliases(c.entityKey, c.aliases, cluster.surfaceForms);
      return { entityKey: c.entityKey, action: "linked", usedLLM: true };
    }
  }
  // Confident no-match, or adjudicator said none → create a new canonical node.
  const entityKey = await createEntity({
    name: cluster.canonicalName,
    entityType: cluster.entityType,
    surfaceForms: cluster.surfaceForms,
    embedding,
    confidence: 0.8,
  });
  return { entityKey, action: "created", usedLLM: outcome.usedLLM };
}
