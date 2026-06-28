export type SynthesisPhaseName = "pattern" | "contradiction" | "gap" | "decay";
export type SynthesisRunResult = "success" | "partial" | "failed";

export interface SynthesisSweepDetails {
  patterns_found?: number;
  insights_created?: number;
  insights_updated?: number;
  contradictions_flagged?: number;
  gaps_created?: number;
  confidence_decayed?: number;
  validation_rejected?: number;
  phase_status?: Partial<Record<SynthesisPhaseName, "ok" | "error">>;
  phase_errors?: Partial<Record<SynthesisPhaseName, string>>;
}

export interface InsightLink {
  memoryId: string;
  content: string;
  createdAt: string;
}

export interface SynthesisRun {
  id: number;
  ts: string;
  summary: string;
  durationMs: number | null;
  auditStatus: "ok" | "error";
  result: SynthesisRunResult;
  details: SynthesisSweepDetails;
  createdInsights: InsightLink[];
}

export interface GapRelatedMemory {
  memoryId: string;
  content: string;
  primaryType: string;
  kind: string | null;
  confidence: number | null;
}

export interface GapRecord {
  memoryId: string;
  content: string;
  topic: string;
  priority: string;
  state: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  deletedAt: string | null;
  confidence: number | null;
  accessCount: number;
  prompts: string[];
  tags: string[];
  relatedMemories: GapRelatedMemory[];
}

export interface ContradictionMemory {
  memoryId: string;
  content: string;
  confidence: number;
  primaryType: string;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
  lastRevisedAt: string | null;
}

export interface ContradictionPair {
  key: string;
  note: string;
  confidence: number;
  resolvedAt: string;
  left: ContradictionMemory;
  right: ContradictionMemory;
}

export function tagValue(tags: string[], prefix: string): string | null {
  const match = tags.find((tag) => tag.toLowerCase().startsWith(prefix.toLowerCase()));
  return match ? match.slice(prefix.length).trim() : null;
}

export function replaceStatusTag(tags: string[], nextState: "open" | "closed"): string[] {
  const next = tags.filter((tag) => !tag.toLowerCase().startsWith("status:"));
  next.push(`status:${nextState}`);
  return next;
}

export function gapPriority(tags: string[]): string {
  return tagValue(tags, "priority:") ?? "low";
}

export function gapTopic(tags: string[], content: string): string {
  const tagged = tagValue(tags, "gap:");
  if (tagged) return tagged.replace(/-/g, " ");
  const firstLine = content.split("\n")[0] ?? content;
  return firstLine.replace(/^Knowledge gap:\s*/i, "").trim();
}

export function gapState(tags: string[], deletedAt: string | null | undefined): "open" | "closed" {
  const status = tagValue(tags, "status:");
  if (status === "closed" || deletedAt) return "closed";
  return "open";
}

export function parseGapPrompts(content: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === "suggested prompts:");
  if (start === -1) return [];
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

export function synthesisResult(
  auditStatus: "ok" | "error",
  phaseStatus?: Partial<Record<SynthesisPhaseName, "ok" | "error">>,
): SynthesisRunResult {
  if (auditStatus === "error") return "failed";
  if (Object.values(phaseStatus ?? {}).some((value) => value === "error")) return "partial";
  return "success";
}

export function pairKey(leftMemoryId: string, rightMemoryId: string): string {
  return [leftMemoryId, rightMemoryId].sort().join("::");
}

export function excerpt(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}
