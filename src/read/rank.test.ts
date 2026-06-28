import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRecallRow } from "../db/retrieve.js";
import { adaptiveTokenBudget, hasConfidentTaskInference, rankMemories, scoreRow } from "./rank.js";

test("normalizeRecallRow coalesces intelligence defaults for old memories", () => {
  const row = normalizeRecallRow({
    memoryId: "m1",
    content: "Prefers compact diffs",
    primaryType: "SEMANTIC",
    weight: 0.8,
    confidence: 0.75,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
  });

  assert.equal(row.freshness, 1);
  assert.equal(row.basis, "direct_statement");
  assert.equal(row.lastRevisedAt, "2026-06-20T10:00:00Z");
});

test("missing freshness stays neutral while low freshness demotes ranking", () => {
  const base = normalizeRecallRow({
    memoryId: "m1",
    content: "Use async workers for long-running jobs",
    primaryType: "PROCEDURAL",
    weight: 0.9,
    confidence: 0.7,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
    distance: 0.2,
  });
  const neutralFreshness = { ...base, freshness: 1 };
  const withLowFreshness = { ...base, freshness: 0.1 };

  assert.equal(scoreRow(base), scoreRow(neutralFreshness));
  assert.ok(scoreRow(withLowFreshness) < scoreRow(base));
});

test("adaptiveTokenBudget falls back to current default when task inference is low confidence", () => {
  assert.equal(hasConfidentTaskInference({ taskConfidence: 0.59, taskType: "decision" }), false);
  assert.equal(adaptiveTokenBudget({ taskConfidence: 0.59, taskType: "decision", criticality: "high" }), 500);
});

test("rankMemories keeps default ordering when task inference is low confidence", () => {
  const procedural = normalizeRecallRow({
    memoryId: "m-proc",
    content: "Run the migration in dry-run mode first",
    primaryType: "PROCEDURAL",
    weight: 0.8,
    confidence: 0.8,
    freshness: 1,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
    distance: 0.25,
  });
  const semantic = normalizeRecallRow({
    memoryId: "m-sem",
    content: "The team values simpler rollouts over novelty",
    primaryType: "SEMANTIC",
    weight: 0.8,
    confidence: 0.8,
    freshness: 1,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
    distance: 0.2,
  });

  const ranked = rankMemories([[procedural, semantic]], {
    tokenBudget: 500,
    taskType: "decision",
    criticality: "high",
    taskConfidence: 0.4,
  });

  assert.deepEqual(ranked.map((memory) => memory.memoryId), ["m-proc", "m-sem"]);
});

test("rankMemories filters low-confidence memories for high-criticality tasks", () => {
  const highConfidence = normalizeRecallRow({
    memoryId: "m-high",
    content: "Established deployment runbook",
    primaryType: "PROCEDURAL",
    weight: 0.9,
    confidence: 0.8,
    freshness: 1,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
    distance: 0.2,
  });
  const lowConfidence = normalizeRecallRow({
    memoryId: "m-low",
    content: "Speculative remediation note",
    primaryType: "PROCEDURAL",
    weight: 1,
    confidence: 0.6,
    freshness: 1,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
    distance: 0.1,
  });

  const ranked = rankMemories([[highConfidence, lowConfidence]], {
    tokenBudget: 800,
    taskType: "debugging",
    criticality: "high",
    taskConfidence: 0.9,
  });

  assert.deepEqual(ranked.map((memory) => memory.memoryId), ["m-high"]);
});

test("rankMemories guarantees the top memory even when the token budget is tiny", () => {
  const row = normalizeRecallRow({
    memoryId: "m1",
    content: "A".repeat(200),
    primaryType: "SEMANTIC",
    weight: 1,
    confidence: 0.9,
    freshness: 1,
    createdAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-21T10:00:00Z",
    distance: 0.2,
  });

  const ranked = rankMemories([[row]], 10);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].memoryId, "m1");
});
