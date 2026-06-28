import { GraphData, GraphLink, GraphNode } from "../types";

export type MemoryPrimaryType = "EPISODIC" | "SEMANTIC" | "PROCEDURAL" | "CONTEXTUAL" | "GOAL";

function endNodeId(end: string | GraphNode): string {
  return typeof end === "object" ? end.id : end;
}

export function tagValue(tags: unknown, prefix: string): string | null {
  if (!Array.isArray(tags)) return null;
  const match = tags.find((tag) => typeof tag === "string" && tag.toLowerCase().startsWith(prefix.toLowerCase()));
  return typeof match === "string" ? match.slice(prefix.length).trim() : null;
}

export function isMemoryNode(node: Pick<GraphNode, "label">): boolean {
  return node.label === "Memory";
}

export function memoryPrimaryType(node: GraphNode): MemoryPrimaryType | null {
  const primaryType = node.props?.primaryType;
  return typeof primaryType === "string" ? primaryType as MemoryPrimaryType : null;
}

export function memoryKind(node: GraphNode): string | null {
  const kind = node.props?.kind;
  return typeof kind === "string" && kind.trim() ? kind : null;
}

export function hasContradictionMarker(node: GraphNode): boolean {
  return node.props?.hasContradiction === true;
}

export function hasSyntheticMarker(node: GraphNode): boolean {
  return memoryKind(node) === "synthetic";
}

export function hasGapMarker(node: GraphNode): boolean {
  return memoryKind(node) === "knowledge_gap";
}

export function memoryTitle(node: GraphNode): string {
  if (typeof node.props?.content === "string" && node.props.content.trim()) return node.props.content.trim();
  if (typeof node.props?.name === "string" && node.props.name.trim()) return node.props.name.trim();
  return node.label;
}

export function contradictionNote(node: GraphNode): string | null {
  const contradictions = node.props?.contradictions;
  if (!Array.isArray(contradictions) || contradictions.length === 0) return null;
  const note = contradictions[0]?.resolution;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

export function suggestedPrompts(node: GraphNode): string[] {
  const content = typeof node.props?.content === "string" ? node.props.content : "";
  const marker = "Suggested prompts:";
  const index = content.indexOf(marker);
  if (index < 0) return [];
  return content
    .slice(index + marker.length)
    .split("\n")
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter(Boolean);
}

export function gapStatus(node: GraphNode): string | null {
  return tagValue(node.props?.tags, "status:");
}

export function gapTopic(node: GraphNode): string | null {
  const tagged = tagValue(node.props?.tags, "gap:");
  if (tagged) return tagged.replace(/-/g, " ");
  return null;
}

export function gapPriority(node: GraphNode): string | null {
  return tagValue(node.props?.tags, "priority:");
}

export function gaugeValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

export function linkResolution(link: GraphLink): string | null {
  const resolution = link.props?.resolution;
  return typeof resolution === "string" && resolution.trim() ? resolution.trim() : null;
}

export function relatedNodesByEdge(
  node: GraphNode,
  data: GraphData,
  edgeType: string,
): GraphNode[] {
  const related = new Map<string, GraphNode>();
  for (const link of data.links) {
    if (link.type !== edgeType) continue;
    const sourceId = endNodeId(link.source);
    const targetId = endNodeId(link.target);
    if (sourceId !== node.id && targetId !== node.id) continue;
    const otherId = sourceId === node.id ? targetId : sourceId;
    const other = data.nodes.find((candidate) => candidate.id === otherId);
    if (other) related.set(other.id, other);
  }
  return [...related.values()];
}

export function findMemoryByMemoryId(data: GraphData, memoryId: string): GraphNode | null {
  return data.nodes.find((candidate) => candidate.label === "Memory" && candidate.props?.memoryId === memoryId) ?? null;
}

export function contradictionTargets(node: GraphNode, data: GraphData): GraphNode[] {
  const contradictions = Array.isArray(node.props?.contradictions) ? node.props.contradictions : [];
  const matches = contradictions
    .map((entry) => typeof entry?.withMemoryId === "string" ? findMemoryByMemoryId(data, entry.withMemoryId) : null)
    .filter((candidate): candidate is GraphNode => candidate != null);
  if (matches.length > 0) return matches;
  return relatedNodesByEdge(node, data, "CONTRADICTS");
}

export function markerCounts(data: GraphData): { synthetic: number; gap: number; contradiction: number } {
  return data.nodes.reduce((acc, node) => {
    if (!isMemoryNode(node)) return acc;
    if (hasSyntheticMarker(node)) acc.synthetic++;
    if (hasGapMarker(node)) acc.gap++;
    if (hasContradictionMarker(node)) acc.contradiction++;
    return acc;
  }, { synthetic: 0, gap: 0, contradiction: 0 });
}
