// Fixed, user-friendly palette so each node type is instantly distinguishable
// and edges never blend into Memory nodes.

export const NODE_COLORS: Record<string, string> = {
  Memory: "#a78bfa", // soft violet
  Entity: "#34d399", // emerald
  Category: "#38bdf8", // sky blue
  Session: "#fb7185", // rose
};

export const DEFAULT_NODE_COLOR = "#94a3b8"; // slate — unknown labels
export const EDGE_COLOR = "#475569"; // muted gray-blue — clearly not a node
export const EDGE_HIGHLIGHT_COLOR = "#e2e8f0"; // bright edge when connected to selection

export const nodeColor = (label?: string): string =>
  NODE_COLORS[label ?? ""] ?? DEFAULT_NODE_COLOR;
