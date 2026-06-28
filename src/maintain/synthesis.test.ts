import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyConfidenceDecay,
  buildContradictionPairs,
  clusterPatternMemories,
  contradictionDetectionPhase,
  gapDetectionPhase,
  patternDetectionPhase,
  synthesizeSweep,
  type ContradictionCandidateMemory,
  type GapSourceMemory,
  type OpenGapMemory,
  type PatternSourceMemory,
  type SemanticTopicMemory,
} from "./synthesis.js";

test("applyConfidenceDecay multiplies by 0.95 and floors at 0.25", () => {
  assert.equal(applyConfidenceDecay(0.8), 0.76);
  assert.equal(applyConfidenceDecay(0.25), 0.25);
  assert.equal(applyConfidenceDecay(0.2), 0.25);
});

test("synthesizeSweep runs phases in order and isolates phase failures", async () => {
  const order: string[] = [];
  const result = await synthesizeSweep({
    pattern: async () => {
      order.push("pattern");
      return { patterns_found: 3, insights_created: 2, insights_updated: 1 };
    },
    contradiction: async () => {
      order.push("contradiction");
      throw new Error("contradiction stub exploded");
    },
    gap: async () => {
      order.push("gap");
      return { gaps_created: 4 };
    },
    decay: async () => {
      order.push("decay");
      return { confidence_decayed: 5, validation_rejected: 0 };
    },
  });

  assert.deepEqual(order, ["pattern", "contradiction", "gap", "decay"]);
  assert.equal(result.details.patterns_found, 3);
  assert.equal(result.details.insights_created, 2);
  assert.equal(result.details.insights_updated, 1);
  assert.equal(result.details.gaps_created, 4);
  assert.equal(result.details.confidence_decayed, 5);
  assert.equal(result.details.phase_status.pattern, "ok");
  assert.equal(result.details.phase_status.contradiction, "error");
  assert.equal(result.details.phase_status.gap, "ok");
  assert.equal(result.details.phase_status.decay, "ok");
  assert.match(result.details.phase_errors?.contradiction ?? "", /exploded/);
  assert.match(result.summary, /5 confidence decayed/);
});

function mem(
  memoryId: string,
  createdAt: string,
  sourceSessionId: string,
  embedding: number[],
  content = `${memoryId} content`,
): PatternSourceMemory {
  return {
    memoryId,
    content,
    embedding,
    sourceSessionId,
    createdAt,
    primaryType: "EPISODIC",
  };
}

function contradictionMem(
  memoryId: string,
  primaryType: "SEMANTIC" | "PROCEDURAL",
  embedding: number[],
  tags: string[],
  createdAt: string,
  content = `${memoryId} content`,
): ContradictionCandidateMemory {
  return {
    memoryId,
    content,
    embedding,
    tags,
    primaryType,
    createdAt,
  };
}

function gapMem(
  memoryId: string,
  createdAt: string,
  sourceSessionId: string,
  embedding: number[],
  content: string,
  primaryType: "EPISODIC" | "GOAL" | "CONTEXTUAL" = "EPISODIC",
  tags: string[] = [],
): GapSourceMemory {
  return {
    memoryId,
    content,
    embedding,
    tags,
    sourceSessionId,
    createdAt,
    primaryType,
  };
}

function semanticMem(
  memoryId: string,
  embedding: number[],
  content: string,
  tags: string[] = [],
  createdAt = "2026-06-01T00:00:00Z",
): SemanticTopicMemory {
  return {
    memoryId,
    content,
    embedding,
    tags,
    createdAt,
  };
}

function openGap(
  memoryId: string,
  topicTag: string,
  embedding: number[],
  expiresAt = "2026-07-20T00:00:00Z",
  accessCount = 0,
): OpenGapMemory {
  return {
    memoryId,
    content: `Knowledge gap: ${topicTag}`,
    embedding,
    tags: [topicTag, "priority:high", "status:open"],
    accessCount,
    createdAt: "2026-06-20T00:00:00Z",
    expiresAt,
  };
}

test("clusterPatternMemories groups similar embeddings deterministically", () => {
  const clusters = clusterPatternMemories([
    mem("m1", "2026-06-01T00:00:00Z", "s1", [1, 0]),
    mem("m2", "2026-06-02T00:00:00Z", "s2", [0.99, 0.01]),
    mem("m3", "2026-06-03T00:00:00Z", "s3", [0.98, 0.02]),
    mem("m4", "2026-06-04T00:00:00Z", "s4", [0, 1]),
  ], 0.9);

  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].memories.map((memory) => memory.memoryId), ["m1", "m2", "m3"]);
  assert.deepEqual(clusters[1].memories.map((memory) => memory.memoryId), ["m4"]);
});

test("patternDetectionPhase creates one synthetic insight for a qualifying cluster", async () => {
  let llmCalls = 0;
  const created: Array<{ content: string; derivedFrom: string[]; confidence: number }> = [];
  const result = await patternDetectionPhase({
    nowMs: () => Date.parse("2026-06-28T00:00:00Z"),
    fetchRecentMemories: async () => [
      mem("m1", "2026-06-01T00:00:00Z", "s1", [1, 0], "User prefers async workflows"),
      mem("m2", "2026-06-02T00:00:00Z", "s1", [0.99, 0.01], "They keep choosing async jobs"),
      mem("m3", "2026-06-03T00:00:00Z", "s2", [0.98, 0.02], "Async workers are the default"),
      mem("m4", "2026-06-04T00:00:00Z", "s3", [0.97, 0.03], "They prefer background queues"),
      mem("m5", "2026-06-05T00:00:00Z", "s4", [0.96, 0.04], "Long tasks should run async"),
      mem("m6", "2026-06-06T00:00:00Z", "s9", [0, 1], "Unrelated topic"),
    ],
    synthesizeCluster: async (cluster) => {
      llmCalls++;
      assert.equal(cluster.length, 5);
      return { content: "User prefers async workflows for long-running work", tags: ["async", "workflow"] };
    },
    embedSynthetic: async () => [1, 0],
    findSyntheticMatch: async () => null,
    createSynthetic: async (input) => {
      created.push({ content: input.content, derivedFrom: input.derivedFrom, confidence: input.confidence });
      return "synthetic-1";
    },
  });

  assert.equal(llmCalls, 1);
  assert.equal(result.patterns_found, 1);
  assert.equal(result.insights_created, 1);
  assert.equal(result.insights_updated, 0);
  assert.equal(result.validation_rejected, 0);
  assert.deepEqual(created[0].derivedFrom, ["m1", "m2", "m3", "m4", "m5"]);
  assert.equal(created[0].confidence, 0.85);
});

test("patternDetectionPhase updates an existing synthetic memory instead of creating a duplicate", async () => {
  const updates: Array<{ memoryId: string; derivedFrom: string[]; addedSourceMemoryIds: string[] }> = [];
  const result = await patternDetectionPhase({
    nowMs: () => Date.parse("2026-06-28T00:00:00Z"),
    fetchRecentMemories: async () => [
      mem("m1", "2026-06-01T00:00:00Z", "s1", [1, 0], "Memory 1"),
      mem("m2", "2026-06-02T00:00:00Z", "s2", [1, 0], "Memory 2"),
      mem("m3", "2026-06-03T00:00:00Z", "s3", [1, 0], "Memory 3"),
      mem("m4", "2026-06-04T00:00:00Z", "s4", [1, 0], "Memory 4"),
      mem("m5", "2026-06-05T00:00:00Z", "s5", [1, 0], "Memory 5"),
    ],
    synthesizeCluster: async () => ({ content: "Synthetic insight", tags: ["synthetic"] }),
    embedSynthetic: async () => [1, 0],
    findSyntheticMatch: async () => ({
      memoryId: "existing-synth",
      content: "Synthetic insight",
      derivedFrom: ["m1", "m2"],
      similarity: 0.95,
    }),
    createSynthetic: async () => {
      throw new Error("should not create");
    },
    updateSynthetic: async (input) => {
      updates.push({
        memoryId: input.memoryId,
        derivedFrom: input.derivedFrom,
        addedSourceMemoryIds: input.addedSourceMemoryIds,
      });
    },
  });

  assert.equal(result.patterns_found, 1);
  assert.equal(result.insights_created, 0);
  assert.equal(result.insights_updated, 1);
  assert.deepEqual(updates[0], {
    memoryId: "existing-synth",
    derivedFrom: ["m1", "m2", "m3", "m4", "m5"],
    addedSourceMemoryIds: ["m3", "m4", "m5"],
  });
});

test("buildContradictionPairs only compares within the same memory class", () => {
  const pairs = buildContradictionPairs([
    contradictionMem("s1", "SEMANTIC", [1, 0], ["architecture"], "2026-06-01T00:00:00Z", "Prefers monorepos"),
    contradictionMem("s2", "SEMANTIC", [0.99, 0.01], ["architecture"], "2026-06-02T00:00:00Z", "Moved to microservices"),
    contradictionMem("p1", "PROCEDURAL", [0.99, 0.01], ["architecture"], "2026-06-03T00:00:00Z", "Deploy with blue green"),
  ]);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].left.primaryType, "SEMANTIC");
  assert.equal(pairs[0].right.primaryType, "SEMANTIC");
});

test("contradictionDetectionPhase flags judged reversals and reports count", async () => {
  const flagged: Array<{ leftMemoryId: string; rightMemoryId: string; resolution: string }> = [];
  const result = await contradictionDetectionPhase({
    fetchMemories: async () => [
      contradictionMem("m1", "SEMANTIC", [1, 0], ["architecture"], "2026-06-01T00:00:00Z", "User prefers monorepos"),
      contradictionMem("m2", "SEMANTIC", [0.99, 0.01], ["architecture"], "2026-06-10T00:00:00Z", "User decided on microservices"),
      contradictionMem("m3", "SEMANTIC", [0.98, 0.02], ["architecture"], "2026-06-12T00:00:00Z", "Monorepos are hard to navigate"),
    ],
    judgePair: async (pair) => {
      if (pair.left.memoryId === "m1" && pair.right.memoryId === "m2") {
        return { contradicts: true, note: "Later changed direction toward microservices. Both kept; weigh by recency.", confidence: 0.74 };
      }
      return { contradicts: false, note: "", confidence: 0.1 };
    },
    flagPair: async (input) => {
      flagged.push({
        leftMemoryId: input.leftMemoryId,
        rightMemoryId: input.rightMemoryId,
        resolution: input.resolution,
      });
      return true;
    },
  });

  assert.equal(result.contradictions_flagged, 1);
  assert.deepEqual(flagged, [{
    leftMemoryId: "m1",
    rightMemoryId: "m2",
    resolution: "Later changed direction toward microservices. Both kept; weigh by recency.",
  }]);
});

test("gapDetectionPhase creates a capped knowledge gap with prompts and priority tags", async () => {
  const created: Array<{
    content: string;
    tags: string[];
    priority: string;
    relatedMemoryIds: string[];
    expiresAt: string;
  }> = [];

  const result = await gapDetectionPhase({
    nowMs: () => Date.parse("2026-06-28T00:00:00Z"),
    fetchRecentMemories: async () => [
      gapMem("m1", "2026-06-01T00:00:00Z", "s1", [1, 0], "We discussed monitoring gaps"),
      gapMem("m2", "2026-06-03T00:00:00Z", "s2", [0.99, 0.01], "Observability keeps coming up"),
      gapMem("m3", "2026-06-05T00:00:00Z", "s3", [0.98, 0.02], "Alerting came up again"),
      gapMem("m4", "2026-06-07T00:00:00Z", "s4", [0.97, 0.03], "Dashboards are mentioned often"),
      gapMem("m5", "2026-06-09T00:00:00Z", "s1", [0.96, 0.04], "Tracing is still unresolved"),
      gapMem("m6", "2026-06-11T00:00:00Z", "s4", [0.95, 0.05], "Logs vs metrics came up again"),
    ],
    fetchSemanticMemories: async () => [
      semanticMem("s-unrelated", [0, 1], "User prefers short changelogs", ["writing"]),
    ],
    fetchOpenGaps: async () => [],
    draftGap: async ({ semanticCandidates }) => {
      assert.equal(semanticCandidates.length, 0);
      return {
        shouldCreate: true,
        topic: "monitoring",
        label: "user's monitoring approach",
        prompts: ["What monitoring stack do you prefer?", "How do you decide what should page you?"],
        tags: ["observability"],
        confidence: 0.61,
      };
    },
    embedGap: async () => [1, 0],
    createGap: async (input) => {
      created.push({
        content: input.content,
        tags: input.tags,
        priority: input.priority,
        relatedMemoryIds: input.relatedMemoryIds,
        expiresAt: input.expiresAt,
      });
      return "gap-1";
    },
  });

  assert.equal(result.gaps_created, 1);
  assert.equal(result.validation_rejected, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].priority, "high");
  assert.deepEqual(created[0].relatedMemoryIds, ["m1", "m2", "m3", "m4", "m5", "m6"]);
  assert.match(created[0].content, /Knowledge gap: user's monitoring approach/);
  assert.deepEqual(created[0].tags.slice(0, 3), ["gap:monitoring", "priority:high", "status:open"]);
  assert.equal(created[0].expiresAt, "2026-07-28T00:00:00.000Z");
});

test("gapDetectionPhase passes nearby semantic memories into the draft gate and can skip creation", async () => {
  let createCalls = 0;
  const result = await gapDetectionPhase({
    nowMs: () => Date.parse("2026-06-28T00:00:00Z"),
    fetchRecentMemories: async () => [
      gapMem("m1", "2026-06-01T00:00:00Z", "s1", [1, 0], "Monitoring came up in planning"),
      gapMem("m2", "2026-06-02T00:00:00Z", "s2", [0.99, 0.01], "We revisited observability"),
      gapMem("m3", "2026-06-03T00:00:00Z", "s3", [0.98, 0.02], "Alerting tradeoffs were discussed"),
      gapMem("m4", "2026-06-04T00:00:00Z", "s4", [0.97, 0.03], "Tracing surfaced again"),
    ],
    fetchSemanticMemories: async () => [
      semanticMem("sem-1", [1, 0], "User prefers lightweight monitoring with simple alerts", ["observability", "preference"]),
    ],
    fetchOpenGaps: async () => [],
    draftGap: async ({ semanticCandidates }) => {
      assert.deepEqual(semanticCandidates.map((memory) => memory.memoryId), ["sem-1"]);
      return {
        shouldCreate: false,
        topic: "",
        label: "",
        prompts: [],
        tags: [],
      };
    },
    createGap: async () => {
      createCalls++;
      return "gap-should-not-exist";
    },
  });

  assert.equal(result.gaps_created, 0);
  assert.equal(createCalls, 0);
});

test("gapDetectionPhase respects the open-gap cap before drafting new topics", async () => {
  let draftCalls = 0;
  const result = await gapDetectionPhase({
    nowMs: () => Date.parse("2026-06-28T00:00:00Z"),
    maxOpenGaps: 2,
    fetchRecentMemories: async () => [
      gapMem("m1", "2026-06-01T00:00:00Z", "s1", [1, 0], "Monitoring came up"),
      gapMem("m2", "2026-06-02T00:00:00Z", "s2", [0.99, 0.01], "Observability came up"),
      gapMem("m3", "2026-06-03T00:00:00Z", "s3", [0.98, 0.02], "Alerting came up"),
      gapMem("m4", "2026-06-04T00:00:00Z", "s4", [0.97, 0.03], "Dashboards came up"),
    ],
    fetchSemanticMemories: async () => [],
    fetchOpenGaps: async () => [
      openGap("gap-a", "gap:monitoring", [1, 0]),
      openGap("gap-b", "gap:deployment", [0, 1]),
    ],
    draftGap: async () => {
      draftCalls++;
      return {
        shouldCreate: true,
        topic: "monitoring",
        label: "user's monitoring approach",
        prompts: ["What monitoring stack do you prefer?"],
        tags: [],
      };
    },
  });

  assert.equal(result.gaps_created, 0);
  assert.equal(draftCalls, 0);
});
