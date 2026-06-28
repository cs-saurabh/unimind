import { type MemoryPrimaryType } from "./intelligence";

export const NODE_COLORS: Record<string, string> = {
  Entity: "#84cc16", // lime
  Category: "#38bdf8", // sky blue
  Session: "#fb7185", // rose
};

export const MEMORY_PRIMARY_COLORS: Record<MemoryPrimaryType, string> = {
  EPISODIC: "#f59e0b",
  SEMANTIC: "#06b6d4",
  PROCEDURAL: "#8b5cf6",
  CONTEXTUAL: "#e2e8f0",
  GOAL: "#ec4899",
};

export const DEFAULT_NODE_COLOR = "#94a3b8"; // slate — unknown labels
export const MARKER_COLORS = {
  synthetic: "#fbbf24",
  gap: "#cbd5e1",
  contradiction: "#ef4444",
} as const;

export const EDGE_HIGHLIGHT_COLOR = "#e2e8f0"; // bright edge when connected to selection
export const EDGE_STYLES: Record<string, { color: string; width: number; dash?: number[]; opacity?: number }> = {
  MENTIONS: { color: "#475569", width: 0.6, opacity: 0.55 },
  REL: { color: "#60a5fa", width: 0.9, opacity: 0.7 },
  UPDATES: { color: "#c084fc", width: 1.1, dash: [6, 3], opacity: 0.75 },
  EXTENDS: { color: "#2dd4bf", width: 0.9, dash: [4, 2], opacity: 0.7 },
  DERIVES: { color: "#f97316", width: 0.9, dash: [2, 2], opacity: 0.72 },
  IN_CATEGORY: { color: "#38bdf8", width: 0.7, opacity: 0.6 },
  DERIVED_FROM: { color: "#64748b", width: 0.7, dash: [2, 4], opacity: 0.55 },
  SYNTHESIZED_FROM: { color: "#94a3b8", width: 0.8, opacity: 0.6 },
  CONTRADICTS: { color: "#ef4444", width: 1.4, dash: [8, 4], opacity: 0.9 },
  ADDRESSES_GAP: { color: "#22c55e", width: 1.1, opacity: 0.75 },
  RELATED_TO_THEME: { color: "#64748b", width: 0.7, dash: [2, 6], opacity: 0.35 },
};

export const nodeColor = (node: { label?: string; primaryType?: string }): string => {
  if (node.label === "Memory" && typeof node.primaryType === "string") {
    return MEMORY_PRIMARY_COLORS[node.primaryType as MemoryPrimaryType] ?? DEFAULT_NODE_COLOR;
  }
  return NODE_COLORS[node.label ?? ""] ?? DEFAULT_NODE_COLOR;
};

export const edgeStyle = (type?: string) => EDGE_STYLES[type ?? ""] ?? { color: "#475569", width: 0.5, opacity: 0.5 };
