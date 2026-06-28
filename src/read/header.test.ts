import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHeader } from "./header.js";
import type { RankedMemory } from "./rank.js";
import type { RecallRow } from "../db/retrieve.js";

function baseRow(overrides: Partial<RecallRow> = {}): RecallRow {
  return {
    memoryId: "m1",
    content: "User prefers async workers",
    primaryType: "SEMANTIC",
    tags: ["architecture"],
    kind: undefined,
    weight: 0.8,
    confidence: 0.9,
    freshness: 1,
    basis: "direct_statement",
    derivedFrom: [],
    costIfIgnored: null,
    hasContradiction: false,
    contradictions: [],
    stalenessFlag: null,
    accessCount: 0,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
    lastRevisedAt: "2026-06-20T10:00:00Z",
    expiresAt: null,
    distance: 0.2,
    ...overrides,
  };
}

function rankedRow(overrides: Partial<RankedMemory> = {}): RankedMemory {
  return {
    ...baseRow(),
    score: 0.9,
    tokenCost: 12,
    ...overrides,
  };
}

test("buildHeader renders compact annotations and capped knowledge gaps", () => {
  const contradiction = rankedRow({
    memoryId: "m-contradiction",
    content: "User preferred monorepos",
    hasContradiction: true,
    contradictions: [{
      withMemoryId: "m2",
      resolution: "Later chose microservices for future projects",
      confidence: 0.74,
      resolvedAt: "2026-06-25T10:00:00Z",
    }],
  });
  const caution = rankedRow({
    memoryId: "m-caution",
    content: "User runs Kubernetes on AWS",
    confidence: 0.5,
  });
  const gap = baseRow({
    memoryId: "g1",
    primaryType: "CONTEXTUAL",
    kind: "knowledge_gap",
    tags: ["gap:monitoring", "priority:high", "status:open"],
    content: "Knowledge gap: user's monitoring approach",
  });

  const header = buildHeader({
    goals: [],
    contextual: [],
    relFacts: [],
    memories: [contradiction, caution],
    gaps: [gap],
  });

  assert.match(header.text, /Relevant memories:/);
  assert.match(header.text, /User preferred monorepos  ⚠ Later chose microservices for future projects — weigh by recency/);
  assert.match(header.text, /User runs Kubernetes on AWS  \[low confidence · unconfirmed \d+d\]/);
  assert.match(header.text, /Knowledge gaps:\n- No stated approach to monitoring — consider asking/);
  assert.deepEqual(header.annotations, {
    contradiction_notes: 1,
    caution_tags: 1,
    gaps_surfaced: 1,
  });
  assert.deepEqual(header.usedIds, ["m-contradiction", "m-caution", "g1"]);
});
