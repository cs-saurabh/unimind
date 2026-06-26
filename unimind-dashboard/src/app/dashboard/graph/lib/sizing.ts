// Bubble radius reflects "importance / usage":
//   - Memory: weight (reinforcement signal, §5.11) + a minor accessCount boost.
//   - Entity: degree (how many memories mention it) — confidence has no usable variance.
//   - Category / Session: small fixed size.
// Values are sqrt-scaled and normalized over the loaded set so a single hot node
// doesn't dwarf everything. Constants are tunable.

import { RawNode, RawEdge } from "../types";

const MIN_R = 4;
const MAX_R = 20;
const FIXED_R = 5; // Category / Session

const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);

// Map a raw value into [MIN_R, MAX_R] using sqrt of its 0..1 normalized position.
function scale(value: number, min: number, max: number): number {
  if (max <= min) return MIN_R; // no spread → smallest size
  const norm = (value - min) / (max - min);
  return MIN_R + (MAX_R - MIN_R) * Math.sqrt(Math.max(0, Math.min(1, norm)));
}

export function computeRadii(
  nodes: RawNode[],
  edges: RawEdge[],
): Map<string, number> {
  // degree = number of edges touching a node id
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from_node, (degree.get(e.from_node) ?? 0) + 1);
    degree.set(e.to_node, (degree.get(e.to_node) ?? 0) + 1);
  }

  // Memory importance score = weight + 0.05 * accessCount
  const memScore = (n: RawNode) => num(n.weight) + 0.05 * num(n.accessCount);

  const memScores = nodes
    .filter((n) => n.label === "Memory")
    .map(memScore);
  const entDegrees = nodes
    .filter((n) => n.label === "Entity")
    .map((n) => degree.get(n.id) ?? 0);

  const memMin = memScores.length ? Math.min(...memScores) : 0;
  const memMax = memScores.length ? Math.max(...memScores) : 0;
  const entMin = entDegrees.length ? Math.min(...entDegrees) : 0;
  const entMax = entDegrees.length ? Math.max(...entDegrees) : 0;

  const radii = new Map<string, number>();
  for (const n of nodes) {
    if (n.label === "Memory") {
      radii.set(n.id, scale(memScore(n), memMin, memMax));
    } else if (n.label === "Entity") {
      radii.set(n.id, scale(degree.get(n.id) ?? 0, entMin, entMax));
    } else {
      radii.set(n.id, FIXED_R);
    }
  }
  return radii;
}
