import {
  writeBatch,
  readBatch,
  g,
  Predicate,
  PropertyInput,
  Expr,
  PropertyProjection,
} from "@helix-db/helix-db";
import { jsonComplete } from "../llm/complete.js";
import { embedOne } from "../llm/embed.js";
import { combine, cosineSim, distanceToSim, trigramSim } from "../match/scorers.js";
import { helix, writeWithRetry } from "../db/client.js";
import { flagContradictionPair, persistMemory, refreshSyntheticMemory } from "../db/memories.js";
import { L, type MemoryKind } from "../db/schema.js";
import { TENANT_ID, USER_ID } from "../config.js";

const PATTERN_LOOKBACK_DAYS = 30;
const PATTERN_CLUSTER_THRESHOLD = 0.82;
const MIN_PATTERN_MEMORIES = 5;
const MIN_PATTERN_SESSIONS = 3;
const SYNTHETIC_MATCH_HIGH = 0.9;
const SYNTHETIC_SEARCH_K = 12;
const CONTRADICTION_STRONG_SIMILARITY = 0.84;
const CONTRADICTION_BASE_SIMILARITY = 0.72;
const CONTRADICTION_OVERLAP_THRESHOLD = 0.08;
const GAP_LOOKBACK_DAYS = 45;
const GAP_CLUSTER_THRESHOLD = 0.83;
const MIN_GAP_MEMORIES = 4;
const MIN_GAP_SESSIONS = 3;
const MAX_OPEN_GAPS = 4;
const GAP_EXISTING_MATCH_HIGH = 0.88;
const GAP_SEMANTIC_CANDIDATE_FLOOR = 0.66;
const GAP_MAX_SEMANTIC_CANDIDATES = 3;
const GAP_TTL_DAYS = 30;
const CONFIDENCE_DECAY_IDLE_DAYS = 45;
const CONFIDENCE_DECAY_FACTOR = 0.95;
const CONFIDENCE_DECAY_FLOOR = 0.25;

const NUMERIC_DETAIL_KEYS = [
  "patterns_found",
  "insights_created",
  "insights_updated",
  "contradictions_flagged",
  "gaps_created",
  "confidence_decayed",
  "validation_rejected",
] as const;

const PHASE_ORDER = ["pattern", "contradiction", "gap", "decay"] as const;

export type SynthesisPhaseName = (typeof PHASE_ORDER)[number];
export type SynthesisPhaseStatus = "ok" | "error";
type NumericDetailKey = (typeof NUMERIC_DETAIL_KEYS)[number];

export interface SynthesisSweepDetails extends Record<string, unknown> {
  patterns_found: number;
  insights_created: number;
  insights_updated: number;
  contradictions_flagged: number;
  gaps_created: number;
  confidence_decayed: number;
  validation_rejected: number;
  phase_status: Record<SynthesisPhaseName, SynthesisPhaseStatus>;
  phase_errors?: Partial<Record<SynthesisPhaseName, string>>;
}

export interface SynthesisSweepResult {
  summary: string;
  details: SynthesisSweepDetails;
  durationMs: number;
}

export interface SynthesisSweepDeps {
  pattern?: () => Promise<Partial<SynthesisSweepDetails>>;
  contradiction?: () => Promise<Partial<SynthesisSweepDetails>>;
  gap?: () => Promise<Partial<SynthesisSweepDetails>>;
  decay?: () => Promise<Partial<SynthesisSweepDetails>>;
  nowMs?: () => number;
}

export interface PatternSourceMemory {
  memoryId: string;
  content: string;
  embedding: number[];
  sourceSessionId: string | null;
  createdAt: string;
  primaryType: "EPISODIC" | "GOAL";
}

export interface PatternCluster {
  memories: PatternSourceMemory[];
  centroid: number[];
}

export interface SyntheticMatchCandidate {
  memoryId: string;
  content: string;
  derivedFrom: string[];
  similarity: number;
}

export interface PatternSynthesisDraft {
  content: string;
  tags: string[];
}

export interface PatternDetectionDeps {
  fetchRecentMemories?: (lookbackDays: number, nowMs: number) => Promise<PatternSourceMemory[]>;
  synthesizeCluster?: (cluster: PatternSourceMemory[]) => Promise<PatternSynthesisDraft>;
  embedSynthetic?: (content: string) => Promise<number[]>;
  findSyntheticMatch?: (embedding: number[]) => Promise<SyntheticMatchCandidate | null>;
  createSynthetic?: (input: {
    content: string;
    tags: string[];
    embedding: number[];
    confidence: number;
    derivedFrom: string[];
    lastRevisedAt: string;
  }) => Promise<string | null>;
  updateSynthetic?: (input: {
    memoryId: string;
    content: string;
    tags: string[];
    embedding: number[];
    confidence: number;
    derivedFrom: string[];
    lastRevisedAt: string;
    addedSourceMemoryIds: string[];
  }) => Promise<void>;
  clusterThreshold?: number;
  nowMs?: () => number;
}

export interface ContradictionCandidateMemory {
  memoryId: string;
  content: string;
  embedding: number[];
  tags: string[];
  primaryType: "SEMANTIC" | "PROCEDURAL";
  createdAt: string;
}

export interface ContradictionPair {
  left: ContradictionCandidateMemory;
  right: ContradictionCandidateMemory;
  score: number;
}

export interface ContradictionJudgment {
  contradicts: boolean;
  note: string;
  confidence: number;
}

export interface ContradictionDetectionDeps {
  fetchMemories?: () => Promise<ContradictionCandidateMemory[]>;
  judgePair?: (pair: ContradictionPair) => Promise<ContradictionJudgment>;
  flagPair?: (input: {
    leftMemoryId: string;
    rightMemoryId: string;
    resolution: string;
    confidence: number;
    resolvedAt: string;
  }) => Promise<boolean>;
}

export type GapPriority = "critical" | "high" | "medium" | "low";

export interface GapSourceMemory {
  memoryId: string;
  content: string;
  embedding: number[];
  tags: string[];
  sourceSessionId: string | null;
  createdAt: string;
  primaryType: "EPISODIC" | "GOAL" | "CONTEXTUAL";
}

export interface GapCluster {
  memories: GapSourceMemory[];
  centroid: number[];
}

export interface SemanticTopicMemory {
  memoryId: string;
  content: string;
  embedding: number[];
  tags: string[];
  kind?: MemoryKind;
  createdAt: string;
}

export interface OpenGapMemory {
  memoryId: string;
  content: string;
  embedding: number[];
  tags: string[];
  accessCount: number;
  createdAt: string;
  expiresAt: string | null;
}

export interface GapDraft {
  shouldCreate: boolean;
  topic: string;
  label: string;
  prompts: string[];
  tags: string[];
  confidence?: number;
}

export interface GapDetectionDeps {
  fetchRecentMemories?: (lookbackDays: number, nowMs: number) => Promise<GapSourceMemory[]>;
  fetchSemanticMemories?: () => Promise<SemanticTopicMemory[]>;
  fetchOpenGaps?: (nowMs: number) => Promise<OpenGapMemory[]>;
  draftGap?: (input: {
    cluster: GapCluster;
    semanticCandidates: SemanticTopicMemory[];
  }) => Promise<GapDraft>;
  embedGap?: (content: string) => Promise<number[]>;
  createGap?: (input: {
    content: string;
    tags: string[];
    embedding: number[];
    confidence: number;
    relatedMemoryIds: string[];
    derivedFrom: string[];
    expiresAt: string;
    lastRevisedAt: string;
    priority: GapPriority;
  }) => Promise<string | null>;
  clusterThreshold?: number;
  maxOpenGaps?: number;
  nowMs?: () => number;
}

const daysAgoIso = (days: number, nowMs = Date.now()) => new Date(nowMs - days * 86_400_000).toISOString();

function emptyDetails(): SynthesisSweepDetails {
  return {
    patterns_found: 0,
    insights_created: 0,
    insights_updated: 0,
    contradictions_flagged: 0,
    gaps_created: 0,
    confidence_decayed: 0,
    validation_rejected: 0,
    phase_status: {
      pattern: "ok",
      contradiction: "ok",
      gap: "ok",
      decay: "ok",
    },
  };
}

async function countWhere(pred: any): Promise<number> {
  const req = readBatch()
    .varAs("m", g().nWithLabel(L.Memory).where(pred).project([PropertyProjection.new("memoryId")]))
    .returning(["m"]);
  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "synthesis_count" })).send();
  return (res.m?.properties ?? []).length;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
}

function clamp01(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0]?.length ?? 0;
  const out = Array.from({ length: dims }, () => 0);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i++) out[i] += vector[i] ?? 0;
  }
  for (let i = 0; i < dims; i++) out[i] /= vectors.length;
  return out;
}

function distinctSessions(cluster: PatternCluster): Set<string> {
  return new Set(cluster.memories.map((memory) => memory.sourceSessionId?.trim()).filter(Boolean) as string[]);
}

function confidenceForCluster(cluster: PatternCluster): number | null {
  const sessionCount = distinctSessions(cluster).size;
  if (sessionCount < MIN_PATTERN_SESSIONS) return null;
  if (cluster.memories.length >= MIN_PATTERN_MEMORIES) return 0.85;
  if (cluster.memories.length >= 3) return 0.7;
  return null;
}

export function clusterPatternMemories(
  memories: PatternSourceMemory[],
  threshold = PATTERN_CLUSTER_THRESHOLD,
): PatternCluster[] {
  const clusters: PatternCluster[] = [];
  const ordered = [...memories].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.memoryId.localeCompare(b.memoryId),
  );

  for (const memory of ordered) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < clusters.length; i++) {
      const score = cosineSim(memory.embedding, clusters[i].centroid);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= threshold) {
      const cluster = clusters[bestIndex];
      cluster.memories.push(memory);
      cluster.centroid = meanVector(cluster.memories.map((item) => item.embedding));
    } else {
      clusters.push({ memories: [memory], centroid: [...memory.embedding] });
    }
  }

  return clusters;
}

function tagOverlapScore(left: string[], right: string[]): number {
  const l = new Set(left.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  const r = new Set(right.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  if (l.size === 0 || r.size === 0) return 0;
  let inter = 0;
  for (const tag of l) if (r.has(tag)) inter++;
  const union = l.size + r.size - inter;
  return union === 0 ? 0 : inter / union;
}

function contradictionCandidateScore(
  left: ContradictionCandidateMemory,
  right: ContradictionCandidateMemory,
): { semantic: number; overlap: number; score: number } {
  const semantic = cosineSim(left.embedding, right.embedding);
  const overlap = Math.max(tagOverlapScore(left.tags, right.tags), trigramSim(left.content, right.content));
  const score = combine([
    { score: semantic, weight: 0.85 },
    { score: overlap, weight: 0.15 },
  ]);
  return { semantic, overlap, score };
}

export function buildContradictionPairs(memories: ContradictionCandidateMemory[]): ContradictionPair[] {
  const pairs: ContradictionPair[] = [];
  const ordered = [...memories].sort((a, b) =>
    a.primaryType.localeCompare(b.primaryType) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.memoryId.localeCompare(b.memoryId),
  );

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const left = ordered[i];
      const right = ordered[j];
      if (left.primaryType !== right.primaryType) continue;

      const candidate = contradictionCandidateScore(left, right);
      const qualifies = candidate.semantic >= CONTRADICTION_STRONG_SIMILARITY ||
        (candidate.semantic >= CONTRADICTION_BASE_SIMILARITY && candidate.overlap >= CONTRADICTION_OVERLAP_THRESHOLD);
      if (!qualifies) continue;

      pairs.push({ left, right, score: candidate.score });
    }
  }

  return pairs.sort((a, b) => b.score - a.score);
}

function qualifyingPatternClusters(clusters: PatternCluster[]): PatternCluster[] {
  return clusters.filter((cluster) =>
    cluster.memories.length >= MIN_PATTERN_MEMORIES &&
    distinctSessions(cluster).size >= MIN_PATTERN_SESSIONS);
}

function distinctGapSessions(cluster: GapCluster): Set<string> {
  return new Set(cluster.memories.map((memory) => memory.sourceSessionId?.trim()).filter(Boolean) as string[]);
}

function clusterGapText(cluster: GapCluster): string {
  return cluster.memories.map((memory) => memory.content).join("\n");
}

function clusterGapTags(cluster: GapCluster): string[] {
  return normalizeTags(cluster.memories.flatMap((memory) => memory.tags));
}

function latestClusterTimestamp(cluster: GapCluster): string {
  return [...cluster.memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.createdAt ?? "";
}

function gapPriorityForCluster(cluster: GapCluster): GapPriority {
  const sessions = distinctGapSessions(cluster).size;
  const memories = cluster.memories.length;
  if (memories >= 7 && sessions >= 5) return "critical";
  if (memories >= 6 && sessions >= 4) return "high";
  if (memories >= MIN_GAP_MEMORIES && sessions >= MIN_GAP_SESSIONS) return "medium";
  return "low";
}

function gapPriorityScore(priority: GapPriority): number {
  switch (priority) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    default: return 1;
  }
}

function gapWeight(priority: GapPriority): number {
  switch (priority) {
    case "critical": return 0.95;
    case "high": return 0.85;
    case "medium": return 0.72;
    default: return 0.58;
  }
}

function gapDefaultConfidence(priority: GapPriority): number {
  switch (priority) {
    case "critical": return 0.68;
    case "high": return 0.62;
    case "medium": return 0.56;
    default: return 0.5;
  }
}

function normalizeQuestionList(prompts: string[]): string[] {
  const uniq = [...new Set(prompts.map((prompt) => String(prompt).trim()).filter(Boolean))];
  return uniq.slice(0, 3).map((prompt) => prompt.endsWith("?") ? prompt : `${prompt}?`);
}

function normalizeGapTopic(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function tagValue(tags: string[], prefix: string): string | null {
  const match = tags.find((tag) => tag.toLowerCase().startsWith(prefix.toLowerCase()));
  return match ? match.slice(prefix.length).trim() : null;
}

function isGapActive(gap: OpenGapMemory, nowMs: number): boolean {
  const status = tagValue(gap.tags, "status:");
  if (status === "closed") return false;
  const expiresAtMs = gap.expiresAt ? Date.parse(gap.expiresAt) : NaN;
  return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
}

export function clusterGapMemories(
  memories: GapSourceMemory[],
  threshold = GAP_CLUSTER_THRESHOLD,
): GapCluster[] {
  const clusters: GapCluster[] = [];
  const ordered = [...memories].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.memoryId.localeCompare(b.memoryId),
  );

  for (const memory of ordered) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < clusters.length; i++) {
      const score = cosineSim(memory.embedding, clusters[i].centroid);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= threshold) {
      const cluster = clusters[bestIndex];
      cluster.memories.push(memory);
      cluster.centroid = meanVector(cluster.memories.map((item) => item.embedding));
    } else {
      clusters.push({ memories: [memory], centroid: [...memory.embedding] });
    }
  }

  return clusters;
}

function qualifyingGapClusters(clusters: GapCluster[]): GapCluster[] {
  return clusters.filter((cluster) =>
    cluster.memories.length >= MIN_GAP_MEMORIES &&
    distinctGapSessions(cluster).size >= MIN_GAP_SESSIONS);
}

function semanticTopicScore(cluster: GapCluster, memory: SemanticTopicMemory): number {
  return combine([
    { score: cosineSim(cluster.centroid, memory.embedding), weight: 0.8 },
    { score: Math.max(tagOverlapScore(clusterGapTags(cluster), memory.tags), trigramSim(clusterGapText(cluster), memory.content)), weight: 0.2 },
  ]);
}

function semanticCandidatesForCluster(
  cluster: GapCluster,
  semanticMemories: SemanticTopicMemory[],
): SemanticTopicMemory[] {
  return [...semanticMemories]
    .map((memory) => ({ memory, score: semanticTopicScore(cluster, memory) }))
    .filter((entry) => entry.score >= GAP_SEMANTIC_CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, GAP_MAX_SEMANTIC_CANDIDATES)
    .map((entry) => entry.memory);
}

function gapMatchScore(cluster: GapCluster, gap: OpenGapMemory): number {
  return combine([
    { score: cosineSim(cluster.centroid, gap.embedding), weight: 0.85 },
    { score: Math.max(tagOverlapScore(clusterGapTags(cluster), gap.tags), trigramSim(clusterGapText(cluster), gap.content)), weight: 0.15 },
  ]);
}

function hasExistingGapMatch(cluster: GapCluster, openGaps: OpenGapMemory[], topicTag: string): boolean {
  return openGaps.some((gap) =>
    gap.tags.includes(topicTag) || gapMatchScore(cluster, gap) >= GAP_EXISTING_MATCH_HIGH);
}

function buildGapContent(label: string, prompts: string[]): string {
  return [
    `Knowledge gap: ${label}`,
    "The user keeps circling this topic without a durable recorded stance yet.",
    "Suggested prompts:",
    ...prompts.map((prompt) => `- ${prompt}`),
  ].join("\n");
}

async function fetchRecentPatternMemories(
  lookbackDays = PATTERN_LOOKBACK_DAYS,
  nowMs = Date.now(),
): Promise<PatternSourceMemory[]> {
  const cutoff = daysAgoIso(lookbackDays, nowMs);
  const req = readBatch()
    .varAs("memories", g().nWithLabel(L.Memory)
      .where(Predicate.and([
        Predicate.eq("tenant_id", TENANT_ID),
        Predicate.eq("userId", USER_ID),
        Predicate.eq("isLatest", true),
        Predicate.isNull("deletedAt"),
        Predicate.isNull("validTo"),
        Predicate.gte("createdAt", cutoff),
        Predicate.or([
          Predicate.eq("primaryType", "EPISODIC"),
          Predicate.eq("primaryType", "GOAL"),
        ]),
      ]))
      .project([
        PropertyProjection.new("memoryId"),
        PropertyProjection.new("content"),
        PropertyProjection.new("embedding"),
        PropertyProjection.new("sourceSessionId"),
        PropertyProjection.new("createdAt"),
        PropertyProjection.new("primaryType"),
      ]))
    .returning(["memories"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "pattern_recent_memories" })).send();
  return (res.memories?.properties ?? [])
    .filter((row: any) => row.memoryId && row.content && Array.isArray(row.embedding))
    .map((row: any) => ({
      memoryId: String(row.memoryId),
      content: String(row.content),
      embedding: row.embedding.map((value: unknown) => Number(value)),
      sourceSessionId: row.sourceSessionId ? String(row.sourceSessionId) : null,
      createdAt: String(row.createdAt ?? ""),
      primaryType: row.primaryType === "GOAL" ? "GOAL" : "EPISODIC",
    }));
}

async function synthesizePatternCluster(cluster: PatternSourceMemory[]): Promise<PatternSynthesisDraft> {
  const user = cluster
    .map((memory, index) => `${index + 1}. [${memory.primaryType}] ${memory.content}`)
    .join("\n");
  const res = await jsonComplete<{ content?: string; tags?: string[] }>({
    system: `You synthesize one semantic memory from repeated source memories.
Write a single self-contained statement that captures the recurring pattern without
mentioning counts, sessions, or process details. Keep it concise and durable.
Return json: {"content":"...", "tags":["..."]}.`,
    user: `Source memories:\n${user}`,
    maxTokens: 300,
  });
  const content = String(res.content ?? "").trim();
  if (!content) throw new Error("pattern synthesis returned empty content");
  return {
    content,
    tags: normalizeTags(Array.isArray(res.tags) ? res.tags.map((tag) => String(tag)) : ["synthetic", "pattern"]),
  };
}

async function findSyntheticMatch(embedding: number[]): Promise<SyntheticMatchCandidate | null> {
  const req = readBatch()
    .varAs("hits", g().vectorSearchNodesWith(
      L.Memory,
      "embedding",
      PropertyInput.value(embedding),
      Expr.val(SYNTHETIC_SEARCH_K),
      PropertyInput.value(TENANT_ID),
    ).project([
      PropertyProjection.new("memoryId"),
      PropertyProjection.new("content"),
      PropertyProjection.new("primaryType"),
      PropertyProjection.new("kind"),
      PropertyProjection.new("derivedFrom"),
      PropertyProjection.new("isLatest"),
      PropertyProjection.new("validTo"),
      PropertyProjection.new("deletedAt"),
      PropertyProjection.new("userId"),
      PropertyProjection.renamed("$distance", "distance"),
    ]))
    .returning(["hits"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "pattern_synthetic_match" })).send();
  const rows = (res.hits?.properties ?? []).filter((row: any) =>
    row.isLatest === true &&
    !row.deletedAt &&
    !row.validTo &&
    row.userId === USER_ID &&
    row.primaryType === "SEMANTIC" &&
    row.kind === "synthetic");

  const best = rows
    .map((row: any) => ({
      memoryId: String(row.memoryId),
      content: String(row.content ?? ""),
      derivedFrom: Array.isArray(row.derivedFrom) ? row.derivedFrom.map((id: unknown) => String(id)) : [],
      similarity: distanceToSim(Number(row.distance ?? 999)),
    }))
    .sort((a: SyntheticMatchCandidate, b: SyntheticMatchCandidate) => b.similarity - a.similarity)[0];

  return best && best.similarity >= SYNTHETIC_MATCH_HIGH ? best : null;
}

async function fetchContradictionMemories(): Promise<ContradictionCandidateMemory[]> {
  const req = readBatch()
    .varAs("memories", g().nWithLabel(L.Memory)
      .where(Predicate.and([
        Predicate.eq("tenant_id", TENANT_ID),
        Predicate.eq("userId", USER_ID),
        Predicate.eq("isLatest", true),
        Predicate.isNull("deletedAt"),
        Predicate.isNull("validTo"),
        Predicate.or([
          Predicate.eq("primaryType", "SEMANTIC"),
          Predicate.eq("primaryType", "PROCEDURAL"),
        ]),
      ]))
      .project([
        PropertyProjection.new("memoryId"),
        PropertyProjection.new("content"),
        PropertyProjection.new("embedding"),
        PropertyProjection.new("tags"),
        PropertyProjection.new("primaryType"),
        PropertyProjection.new("createdAt"),
      ]))
    .returning(["memories"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "contradiction_memories" })).send();
  return (res.memories?.properties ?? [])
    .filter((row: any) => row.memoryId && row.content && Array.isArray(row.embedding))
    .map((row: any) => ({
      memoryId: String(row.memoryId),
      content: String(row.content),
      embedding: row.embedding.map((value: unknown) => Number(value)),
      tags: Array.isArray(row.tags) ? row.tags.map((tag: unknown) => String(tag)) : [],
      primaryType: row.primaryType === "PROCEDURAL" ? "PROCEDURAL" : "SEMANTIC",
      createdAt: String(row.createdAt ?? ""),
    }));
}

async function fetchGapSourceMemories(
  lookbackDays = GAP_LOOKBACK_DAYS,
  nowMs = Date.now(),
): Promise<GapSourceMemory[]> {
  const cutoff = daysAgoIso(lookbackDays, nowMs);
  const req = readBatch()
    .varAs("memories", g().nWithLabel(L.Memory)
      .where(Predicate.and([
        Predicate.eq("tenant_id", TENANT_ID),
        Predicate.eq("userId", USER_ID),
        Predicate.eq("isLatest", true),
        Predicate.isNull("deletedAt"),
        Predicate.isNull("validTo"),
        Predicate.gte("createdAt", cutoff),
        Predicate.or([
          Predicate.eq("primaryType", "EPISODIC"),
          Predicate.eq("primaryType", "GOAL"),
          Predicate.eq("primaryType", "CONTEXTUAL"),
        ]),
      ]))
      .project([
        PropertyProjection.new("memoryId"),
        PropertyProjection.new("content"),
        PropertyProjection.new("embedding"),
        PropertyProjection.new("tags"),
        PropertyProjection.new("sourceSessionId"),
        PropertyProjection.new("createdAt"),
        PropertyProjection.new("primaryType"),
        PropertyProjection.new("kind"),
      ]))
    .returning(["memories"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "gap_source_memories" })).send();
  return (res.memories?.properties ?? [])
    .filter((row: any) => row.memoryId && row.content && Array.isArray(row.embedding) && row.kind !== "knowledge_gap")
    .map((row: any) => ({
      memoryId: String(row.memoryId),
      content: String(row.content),
      embedding: row.embedding.map((value: unknown) => Number(value)),
      tags: Array.isArray(row.tags) ? row.tags.map((tag: unknown) => String(tag)) : [],
      sourceSessionId: row.sourceSessionId ? String(row.sourceSessionId) : null,
      createdAt: String(row.createdAt ?? ""),
      primaryType: row.primaryType === "GOAL"
        ? "GOAL"
        : row.primaryType === "CONTEXTUAL"
        ? "CONTEXTUAL"
        : "EPISODIC",
    }));
}

async function fetchSemanticTopicMemories(): Promise<SemanticTopicMemory[]> {
  const req = readBatch()
    .varAs("memories", g().nWithLabel(L.Memory)
      .where(Predicate.and([
        Predicate.eq("tenant_id", TENANT_ID),
        Predicate.eq("userId", USER_ID),
        Predicate.eq("isLatest", true),
        Predicate.isNull("deletedAt"),
        Predicate.isNull("validTo"),
        Predicate.eq("primaryType", "SEMANTIC"),
      ]))
      .project([
        PropertyProjection.new("memoryId"),
        PropertyProjection.new("content"),
        PropertyProjection.new("embedding"),
        PropertyProjection.new("tags"),
        PropertyProjection.new("kind"),
        PropertyProjection.new("createdAt"),
      ]))
    .returning(["memories"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "gap_semantic_memories" })).send();
  return (res.memories?.properties ?? [])
    .filter((row: any) => row.memoryId && row.content && Array.isArray(row.embedding))
    .map((row: any) => ({
      memoryId: String(row.memoryId),
      content: String(row.content),
      embedding: row.embedding.map((value: unknown) => Number(value)),
      tags: Array.isArray(row.tags) ? row.tags.map((tag: unknown) => String(tag)) : [],
      kind: typeof row.kind === "string" ? row.kind as MemoryKind : undefined,
      createdAt: String(row.createdAt ?? ""),
    }));
}

async function fetchOpenGapMemories(nowMs = Date.now()): Promise<OpenGapMemory[]> {
  const req = readBatch()
    .varAs("memories", g().nWithLabel(L.Memory)
      .where(Predicate.and([
        Predicate.eq("tenant_id", TENANT_ID),
        Predicate.eq("userId", USER_ID),
        Predicate.eq("isLatest", true),
        Predicate.isNull("deletedAt"),
        Predicate.isNull("validTo"),
        Predicate.eq("primaryType", "CONTEXTUAL"),
        Predicate.eq("kind", "knowledge_gap"),
      ]))
      .project([
        PropertyProjection.new("memoryId"),
        PropertyProjection.new("content"),
        PropertyProjection.new("embedding"),
        PropertyProjection.new("tags"),
        PropertyProjection.new("accessCount"),
        PropertyProjection.new("createdAt"),
        PropertyProjection.new("expiresAt"),
      ]))
    .returning(["memories"]);

  const res: any = await helix.query().dynamic(req.toDynamicRequest({ queryName: "gap_open_memories" })).send();
  return (res.memories?.properties ?? [])
    .filter((row: any) => row.memoryId && row.content && Array.isArray(row.embedding))
    .map((row: any) => ({
      memoryId: String(row.memoryId),
      content: String(row.content),
      embedding: row.embedding.map((value: unknown) => Number(value)),
      tags: Array.isArray(row.tags) ? row.tags.map((tag: unknown) => String(tag)) : [],
      accessCount: Number(row.accessCount ?? 0),
      createdAt: String(row.createdAt ?? ""),
      expiresAt: row.expiresAt ? String(row.expiresAt) : null,
    }))
    .filter((gap: OpenGapMemory) => isGapActive(gap, nowMs));
}

async function judgeContradictionPair(pair: ContradictionPair): Promise<ContradictionJudgment> {
  const older = pair.left.createdAt <= pair.right.createdAt ? pair.left : pair.right;
  const newer = older.memoryId === pair.left.memoryId ? pair.right : pair.left;
  const res = await jsonComplete<{ contradicts?: boolean; note?: string; confidence?: number }>({
    system: `You detect genuine contradiction between two long-term memories.
Flag ONLY a real reversal of stance where both statements cannot comfortably be true at the same time.
Do NOT flag trade-offs, caveats, layered nuance, or "X is hard but still preferred" cases.
Be biased toward false unless the reversal is clear. Return json:
{"contradicts":true|false,"note":"neutral reconciliation note","confidence":0..1}.
If false, note should be empty.`,
    user: `Older memory (${older.createdAt}): ${older.content}
Older tags: ${older.tags.join(", ") || "—"}

Newer memory (${newer.createdAt}): ${newer.content}
Newer tags: ${newer.tags.join(", ") || "—"}

Primary type: ${pair.left.primaryType}`,
    maxTokens: 250,
  });

  const contradicts = Boolean(res.contradicts);
  const note = contradicts ? String(res.note ?? "").trim() : "";
  return {
    contradicts: contradicts && note.length > 0,
    note,
    confidence: clamp01(Number(res.confidence), 0.6),
  };
}

async function draftGapCandidate(input: {
  cluster: GapCluster;
  semanticCandidates: SemanticTopicMemory[];
}): Promise<GapDraft> {
  const recurring = input.cluster.memories
    .map((memory, index) => `${index + 1}. [${memory.primaryType}] ${memory.content}`)
    .join("\n");
  const semantics = input.semanticCandidates.length > 0
    ? input.semanticCandidates
      .map((memory, index) =>
        `${index + 1}. [kind=${memory.kind ?? "raw"}] ${memory.content}\nTags: ${memory.tags.join(", ") || "—"}`,
      )
      .join("\n\n")
    : "None";

  const res = await jsonComplete<{
    shouldCreate?: boolean;
    topic?: string;
    label?: string;
    prompts?: string[];
    tags?: string[];
    confidence?: number;
  }>({
    system: `You detect narrow knowledge gaps from recurring user memories.
Create a gap ONLY when:
- the same topic clearly recurs across the source memories
- the topic is grounded in those memories themselves
- the nearby semantic memories do NOT already record the user's stance, preference, or approach
When unsure, return shouldCreate=false.

Return json:
{"shouldCreate":true|false,"topic":"short topic","label":"short human label","prompts":["question 1?","question 2?"],"tags":["lowercase-tag"],"confidence":0..1}

If shouldCreate=false, leave topic/label/prompts empty.`,
    user: `Recurring source memories:
${recurring}

Nearby semantic memories:
${semantics}`,
    maxTokens: 350,
  });

  const topic = String(res.topic ?? "").trim();
  const label = String(res.label ?? "").trim();
  const prompts = normalizeQuestionList(Array.isArray(res.prompts) ? res.prompts.map((prompt) => String(prompt)) : []);
  return {
    shouldCreate: Boolean(res.shouldCreate) && topic.length > 0 && label.length > 0 && prompts.length > 0,
    topic,
    label,
    prompts,
    tags: normalizeTags(Array.isArray(res.tags) ? res.tags.map((tag) => String(tag).toLowerCase()) : []),
    confidence: clamp01(Number(res.confidence), 0.55),
  };
}

async function createSyntheticInsight(input: {
  content: string;
  tags: string[];
  embedding: number[];
  confidence: number;
  derivedFrom: string[];
  lastRevisedAt: string;
}): Promise<string | null> {
  return persistMemory({
    content: input.content,
    primaryType: "SEMANTIC",
    tags: normalizeTags(input.tags),
    embedding: input.embedding,
    confidence: input.confidence,
    salience: input.confidence,
    mentionKeys: [],
    kind: "synthetic",
    basis: "pattern_analysis",
    derivedFrom: input.derivedFrom,
    lastRevisedAt: input.lastRevisedAt,
    sourceMemoryIds: input.derivedFrom,
  }, { category: "CRON/synthesis", actor: "cron" });
}

async function updateSyntheticInsight(input: {
  memoryId: string;
  content: string;
  tags: string[];
  embedding: number[];
  confidence: number;
  derivedFrom: string[];
  lastRevisedAt: string;
  addedSourceMemoryIds: string[];
}): Promise<void> {
  await refreshSyntheticMemory({
    memoryId: input.memoryId,
    content: input.content,
    tags: normalizeTags(input.tags),
    embedding: input.embedding,
    confidence: input.confidence,
    derivedFrom: input.derivedFrom,
    lastRevisedAt: input.lastRevisedAt,
    basis: "pattern_analysis",
    addedSourceMemoryIds: input.addedSourceMemoryIds,
  });
}

async function createKnowledgeGap(input: {
  content: string;
  tags: string[];
  embedding: number[];
  confidence: number;
  relatedMemoryIds: string[];
  derivedFrom: string[];
  expiresAt: string;
  lastRevisedAt: string;
  priority: GapPriority;
}): Promise<string | null> {
  return persistMemory({
    content: input.content,
    primaryType: "CONTEXTUAL",
    tags: normalizeTags(input.tags),
    embedding: input.embedding,
    confidence: input.confidence,
    salience: gapWeight(input.priority),
    mentionKeys: [],
    kind: "knowledge_gap",
    freshness: 1,
    derivedFrom: input.derivedFrom,
    expiresAt: input.expiresAt,
    lastRevisedAt: input.lastRevisedAt,
    relatedMemoryIds: input.relatedMemoryIds,
  }, { category: "CRON/synthesis", actor: "cron" });
}

export async function patternDetectionPhase(deps: PatternDetectionDeps = {}): Promise<Partial<SynthesisSweepDetails>> {
  const nowMs = deps.nowMs?.() ?? Date.now();
  const fetchRecent = deps.fetchRecentMemories ?? fetchRecentPatternMemories;
  const synthesizeCluster = deps.synthesizeCluster ?? synthesizePatternCluster;
  const embedSynthetic = deps.embedSynthetic ?? embedOne;
  const searchSynthetic = deps.findSyntheticMatch ?? findSyntheticMatch;
  const createSynthetic = deps.createSynthetic ?? createSyntheticInsight;
  const updateSynthetic = deps.updateSynthetic ?? updateSyntheticInsight;

  const clusters = qualifyingPatternClusters(
    clusterPatternMemories(await fetchRecent(PATTERN_LOOKBACK_DAYS, nowMs), deps.clusterThreshold ?? PATTERN_CLUSTER_THRESHOLD),
  );

  let insights_created = 0;
  let insights_updated = 0;
  let validation_rejected = 0;
  const lastRevisedAt = new Date(nowMs).toISOString();

  for (const cluster of clusters) {
    const confidence = confidenceForCluster(cluster);
    if (confidence == null) continue;

    const draft = await synthesizeCluster(cluster.memories);
    const embedding = await embedSynthetic(draft.content);
    const derivedFrom = cluster.memories.map((memory) => memory.memoryId);
    const existing = await searchSynthetic(embedding);

    if (existing) {
      const union = [...new Set([...existing.derivedFrom, ...derivedFrom])];
      const addedSourceMemoryIds = union.filter((id) => !existing.derivedFrom.includes(id));
      await updateSynthetic({
        memoryId: existing.memoryId,
        content: draft.content,
        tags: draft.tags,
        embedding,
        confidence,
        derivedFrom: union,
        lastRevisedAt,
        addedSourceMemoryIds,
      });
      insights_updated++;
      continue;
    }

    const created = await createSynthetic({
      content: draft.content,
      tags: draft.tags,
      embedding,
      confidence,
      derivedFrom,
      lastRevisedAt,
    });
    if (created) insights_created++;
    else validation_rejected++;
  }

  return {
    patterns_found: clusters.length,
    insights_created,
    insights_updated,
    validation_rejected,
  };
}

export async function contradictionDetectionPhase(
  deps: ContradictionDetectionDeps = {},
): Promise<Partial<SynthesisSweepDetails>> {
  const fetchMemories = deps.fetchMemories ?? fetchContradictionMemories;
  const judgePair = deps.judgePair ?? judgeContradictionPair;
  const flagPair = deps.flagPair ?? flagContradictionPair;
  const resolvedAt = new Date().toISOString();

  let contradictions_flagged = 0;
  for (const pair of buildContradictionPairs(await fetchMemories())) {
    const judgment = await judgePair(pair);
    if (!judgment.contradicts) continue;

    const flagged = await flagPair({
      leftMemoryId: pair.left.memoryId,
      rightMemoryId: pair.right.memoryId,
      resolution: judgment.note,
      confidence: judgment.confidence,
      resolvedAt,
    });
    if (flagged) contradictions_flagged++;
  }

  return { contradictions_flagged };
}

export async function gapDetectionPhase(
  deps: GapDetectionDeps = {},
): Promise<Partial<SynthesisSweepDetails>> {
  const nowMs = deps.nowMs?.() ?? Date.now();
  const fetchRecent = deps.fetchRecentMemories ?? fetchGapSourceMemories;
  const fetchSemantic = deps.fetchSemanticMemories ?? fetchSemanticTopicMemories;
  const fetchOpenGaps = deps.fetchOpenGaps ?? fetchOpenGapMemories;
  const draftGap = deps.draftGap ?? draftGapCandidate;
  const embedGap = deps.embedGap ?? embedOne;
  const createGap = deps.createGap ?? createKnowledgeGap;

  const openGaps = await fetchOpenGaps(nowMs);
  const maxOpenGaps = deps.maxOpenGaps ?? MAX_OPEN_GAPS;
  let remainingSlots = Math.max(0, maxOpenGaps - openGaps.length);
  if (remainingSlots === 0) return { gaps_created: 0 };

  const semanticMemories = await fetchSemantic();
  const clusters = qualifyingGapClusters(
    clusterGapMemories(await fetchRecent(GAP_LOOKBACK_DAYS, nowMs), deps.clusterThreshold ?? GAP_CLUSTER_THRESHOLD),
  );
  const candidates = clusters
    .map((cluster) => ({
      cluster,
      priority: gapPriorityForCluster(cluster),
      semanticCandidates: semanticCandidatesForCluster(cluster, semanticMemories),
    }))
    .sort((left, right) =>
      gapPriorityScore(right.priority) - gapPriorityScore(left.priority) ||
      right.cluster.memories.length - left.cluster.memories.length ||
      distinctGapSessions(right.cluster).size - distinctGapSessions(left.cluster).size ||
      latestClusterTimestamp(right.cluster).localeCompare(latestClusterTimestamp(left.cluster)),
    );

  let gaps_created = 0;
  let validation_rejected = 0;
  const runtimeOpenGaps = [...openGaps];
  const seenTopics = new Set<string>();
  const lastRevisedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + GAP_TTL_DAYS * 86_400_000).toISOString();

  for (const candidate of candidates) {
    if (remainingSlots <= 0) break;

    const draft = await draftGap({
      cluster: candidate.cluster,
      semanticCandidates: candidate.semanticCandidates,
    });
    if (!draft.shouldCreate) continue;

    const topicTag = `gap:${normalizeGapTopic(draft.topic || draft.label)}`;
    if (topicTag === "gap:" || seenTopics.has(topicTag)) continue;
    if (hasExistingGapMatch(candidate.cluster, runtimeOpenGaps, topicTag)) continue;

    const prompts = normalizeQuestionList(draft.prompts);
    if (prompts.length === 0) continue;

    const extraTags = draft.tags.filter((tag) =>
      !tag.startsWith("gap:") && !tag.startsWith("priority:") && !tag.startsWith("status:")
    );
    const content = buildGapContent(draft.label, prompts);
    const embedding = await embedGap(content);
    const relatedMemoryIds = candidate.cluster.memories.map((memory) => memory.memoryId);
    const created = await createGap({
      content,
      tags: [topicTag, `priority:${candidate.priority}`, "status:open", ...extraTags],
      embedding,
      confidence: clamp01(draft.confidence ?? gapDefaultConfidence(candidate.priority), gapDefaultConfidence(candidate.priority)),
      relatedMemoryIds,
      derivedFrom: relatedMemoryIds,
      expiresAt,
      lastRevisedAt,
      priority: candidate.priority,
    });

    if (created) {
      gaps_created++;
      remainingSlots--;
      seenTopics.add(topicTag);
      runtimeOpenGaps.push({
        memoryId: created,
        content,
        embedding,
        tags: [topicTag, `priority:${candidate.priority}`, "status:open", ...extraTags],
        accessCount: 0,
        createdAt: lastRevisedAt,
        expiresAt,
      });
    } else {
      validation_rejected++;
    }
  }

  return { gaps_created, validation_rejected };
}

export function applyConfidenceDecay(
  confidence: number,
  factor = CONFIDENCE_DECAY_FACTOR,
  floor = CONFIDENCE_DECAY_FLOOR,
): number {
  return Math.max(floor, confidence * factor);
}

export async function confidenceDecaySweep(
  idleDays = CONFIDENCE_DECAY_IDLE_DAYS,
  factor = CONFIDENCE_DECAY_FACTOR,
  floor = CONFIDENCE_DECAY_FLOOR,
  nowMs = Date.now(),
): Promise<{ confidence_decayed: number }> {
  const cutoff = daysAgoIso(idleDays, nowMs);
  const pred = Predicate.and([
    Predicate.eq("tenant_id", TENANT_ID),
    Predicate.eq("isLatest", true),
    Predicate.isNull("deletedAt"),
    Predicate.neq("primaryType", "CONTEXTUAL"),
    Predicate.neq("decayPolicy", "evergreen"),
    Predicate.lt("lastAccessedAt", cutoff),
  ]);

  const confidence_decayed = await countWhere(pred);
  if (confidence_decayed) {
    const confidenceExpr = Expr.case(
      [[Predicate.lte("confidence", floor / factor), Expr.val(floor)]],
      Expr.prop("confidence").mul(Expr.val(factor)),
    );
    const req = writeBatch()
      .varAs("m", g().nWithLabel(L.Memory).where(pred)
        .setProperty("confidence", confidenceExpr)
        .setProperty("stalenessFlag", PropertyInput.value("consider_refresh"))
        .setProperty("updatedAt", PropertyInput.value(new Date(nowMs).toISOString())))
      .returning(["m"]);
    await writeWithRetry(req.toDynamicRequest({ queryName: "synthesis_confidence_decay" }));
  }

  return { confidence_decayed };
}

function mergeNumericDetails(
  target: SynthesisSweepDetails,
  patch: Partial<SynthesisSweepDetails>,
): void {
  for (const key of NUMERIC_DETAIL_KEYS) {
    const value = patch[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] += value;
    }
  }
}

function buildSummary(details: SynthesisSweepDetails): string {
  const base =
    `synthesis sweep: ${details.insights_created} insights created, ` +
    `${details.contradictions_flagged} contradictions flagged, ` +
    `${details.gaps_created} gaps created, ` +
    `${details.confidence_decayed} confidence decayed`;
  if (!details.phase_errors || Object.keys(details.phase_errors).length === 0) return base;
  return `${base} (phase errors: ${Object.keys(details.phase_errors).join(", ")})`;
}

export async function synthesizeSweep(deps: SynthesisSweepDeps = {}): Promise<SynthesisSweepResult> {
  const startedAt = deps.nowMs?.() ?? Date.now();
  const details = emptyDetails();
  const phaseErrors: Partial<Record<SynthesisPhaseName, string>> = {};
  const phaseImpl = {
    pattern: deps.pattern ?? (() => patternDetectionPhase({ nowMs: () => startedAt })),
    contradiction: deps.contradiction ?? contradictionDetectionPhase,
    gap: deps.gap ?? (() => gapDetectionPhase({ nowMs: () => startedAt })),
    decay: deps.decay ?? (() => confidenceDecaySweep(CONFIDENCE_DECAY_IDLE_DAYS, CONFIDENCE_DECAY_FACTOR, CONFIDENCE_DECAY_FLOOR, startedAt)),
  } satisfies Record<SynthesisPhaseName, () => Promise<Partial<SynthesisSweepDetails>>>;

  for (const phase of PHASE_ORDER) {
    try {
      const patch = await phaseImpl[phase]();
      mergeNumericDetails(details, patch);
      details.phase_status[phase] = "ok";
    } catch (err) {
      details.phase_status[phase] = "error";
      phaseErrors[phase] = String((err as Error)?.message ?? err);
    }
  }

  if (Object.keys(phaseErrors).length > 0) details.phase_errors = phaseErrors;

  return {
    summary: buildSummary(details),
    details,
    durationMs: (deps.nowMs?.() ?? Date.now()) - startedAt,
  };
}
