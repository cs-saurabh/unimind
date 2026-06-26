// Graph v2 — self-contained types. Nothing shared with the legacy /visualize page.

// Raw node as returned by GET /api/nodes-edges (a node carries id, label and all its props).
export interface RawNode {
  id: string;
  label?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// Raw edge as returned by GET /api/nodes-edges.
export interface RawEdge {
  id: string;
  label?: string;
  from_node: string;
  to_node: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// A node prepared for react-force-graph. The library mutates x/y/vx/vy onto it at runtime.
export interface GraphNode {
  id: string;
  label: string;
  props: RawNode; // full property bag, shown verbatim in the RHS panel
  color: string;
  radius: number;
  // mutated by the force engine:
  x?: number;
  y?: number;
}

// A link prepared for react-force-graph. source/target start as ids; the library
// replaces them with node-object references after the first tick.
export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  type: string; // edge label, e.g. "MENTIONS"
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
