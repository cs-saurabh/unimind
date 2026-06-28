import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMemoryNode } from "./memoryValidation.js";
import type { MemoryNode } from "./schema.js";

function baseMemory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    memoryId: "m1",
    tenant_id: "tenant",
    userId: "user",
    primaryType: "SEMANTIC",
    tags: ["preference"],
    content: "User prefers terse answers",
    embedding: [0.1, 0.2],
    weight: 0.8,
    confidence: 0.75,
    isLatest: true,
    createdAt: "2026-06-20T10:00:00Z",
    updatedAt: "2026-06-20T10:00:00Z",
    lastAccessedAt: "2026-06-20T10:00:00Z",
    accessCount: 0,
    validFrom: "2026-06-20T10:00:00Z",
    decayPolicy: "slow",
    ...overrides,
  };
}

test("validateMemoryNode accepts a direct statement with optional fields omitted", async () => {
  const result = await validateMemoryNode(baseMemory(), { now: new Date("2026-06-28T00:00:00Z") });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test("validateMemoryNode enforces synthetic kind rules", async () => {
  const result = await validateMemoryNode(
    baseMemory({ primaryType: "EPISODIC", kind: "synthetic", derivedFrom: [] }),
    { now: new Date("2026-06-28T00:00:00Z") },
  );

  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" | "), /EPISODIC memories cannot set kind/);
  assert.match(result.reasons.join(" | "), /synthetic memories must be SEMANTIC or PROCEDURAL/);
  assert.match(result.reasons.join(" | "), /derivedFrom/);
});

test("validateMemoryNode enforces gap freshness and contradiction consistency rules", async () => {
  const result = await validateMemoryNode(
    baseMemory({
      primaryType: "SEMANTIC",
      kind: "knowledge_gap",
      freshness: 1.2,
      lastRevisedAt: "2026-07-01T00:00:00Z",
      hasContradiction: true,
      contradictions: [{
        withMemoryId: "missing-memory",
        resolution: "",
        confidence: 1.2,
        resolvedAt: "not-a-date",
      }],
    }),
    {
      now: new Date("2026-06-28T00:00:00Z"),
      existingMemoryIds: async () => new Set<string>(),
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" | "), /knowledge_gap memories must be CONTEXTUAL/);
  assert.match(result.reasons.join(" | "), /knowledge_gap memories must set expiresAt/);
  assert.match(result.reasons.join(" | "), /freshness must be a finite number between 0 and 1/);
  assert.match(result.reasons.join(" | "), /lastRevisedAt cannot be in the future/);
  assert.match(result.reasons.join(" | "), /resolution is required/);
  assert.match(result.reasons.join(" | "), /confidence must be between 0 and 1/);
  assert.match(result.reasons.join(" | "), /resolvedAt must be a valid RFC3339 timestamp/);
  assert.match(result.reasons.join(" | "), /missing memoryId "missing-memory"/);
});

test("validateMemoryNode requires hasContradiction when contradiction records exist", async () => {
  const result = await validateMemoryNode(
    baseMemory({
      contradictions: [{
        withMemoryId: "m2",
        resolution: "These two instructions disagree",
        confidence: 0.7,
        resolvedAt: "2026-06-20T10:00:00Z",
      }],
    }),
    {
      now: new Date("2026-06-28T00:00:00Z"),
      existingMemoryIds: async () => new Set(["m2"]),
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" | "), /contradictions require hasContradiction=true/);
});
