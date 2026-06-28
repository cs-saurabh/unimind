import { useCallback, useEffect, useState } from "react";
import { fetchGraph } from "../lib/api";
import { computeRadii } from "../lib/sizing";
import { nodeColor } from "../lib/colors";
import { GraphData, GraphLink, GraphNode } from "../types";

export const DEFAULT_LIMIT = 5000;

export function useGraphData() {
  const [data, setData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  const load = useCallback(async (fetchLimit: number) => {
    setLoading(true);
    setError(null);
    try {
      const { nodes: rawNodes, edges: rawEdges } = await fetchGraph(fetchLimit);

      const radii = computeRadii(rawNodes, rawEdges);
      const nodes: GraphNode[] = rawNodes.map((n) => ({
        id: n.id,
        label: n.label ?? "Node",
        props: n,
        color: nodeColor(n),
        radius: radii.get(n.id) ?? 4,
      }));

      // Drop any edge whose endpoint isn't in the node set — react-force-graph
      // throws on links that reference unknown node ids.
      const nodeIds = new Set(nodes.map((n) => n.id));
      const links: GraphLink[] = rawEdges
        .filter((e) => nodeIds.has(e.from_node) && nodeIds.has(e.to_node))
        .map((e) => ({
          id: e.id,
          source: e.from_node,
          target: e.to_node,
          type: e.label ?? "Edge",
          props: e,
        }));

      setData({ nodes, links });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph");
      setData({ nodes: [], links: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    load(DEFAULT_LIMIT);
  }, [load]);

  const refetch = useCallback(
    (newLimit: number) => {
      setLimit(newLimit);
      load(newLimit);
    },
    [load],
  );

  return { data, loading, error, limit, refetch };
}
