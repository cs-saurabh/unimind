"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { forceX, forceY } from "d3-force";
import { GraphData, GraphLink, GraphNode } from "../types";
import { EDGE_COLOR, EDGE_HIGHLIGHT_COLOR } from "../lib/colors";
import { ForceSettings } from "../lib/forceSettings";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// react-force-graph replaces link.source/target with node objects after the first
// tick; before that they are plain ids. Resolve either shape to an id.
function endId(end: string | GraphNode): string {
  return typeof end === "object" ? end.id : end;
}

interface GraphCanvasProps {
  data: GraphData;
  selectedId: string | null;
  settings: ForceSettings;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  data,
  selectedId,
  settings,
  onNodeClick,
  onBackgroundClick,
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const didFitRef = useRef(false);
  const forcesAppliedRef = useRef(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Apply custom forces. react-force-graph rebuilds the simulation (resetting
  // forces to defaults) whenever graphData changes, so this must re-run per dataset.
  const configureForces = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")
      .strength(settings.chargeStrength)
      .distanceMax(settings.chargeDistanceMax);
    fg.d3Force("link").distance(settings.linkDistance);
    fg.d3Force("x", forceX(0).strength(settings.gravityStrength));
    fg.d3Force("y", forceY(0).strength(settings.gravityStrength));
    forcesAppliedRef.current = true;
  }, [settings]);

  // Adjacency for highlight + dimming. Ids never change, so build once per dataset.
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const l of data.links) {
      const s = endId(l.source);
      const t = endId(l.target);
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  }, [data]);

  // The "active" node = selected (sticky) or hovered. Drives highlight/dim.
  const activeId = selectedId ?? hoveredId;

  const isHighlightedNode = (id: string): boolean => {
    if (!activeId) return true; // nothing active → everything full opacity
    return id === activeId || (neighbors.get(activeId)?.has(id) ?? false);
  };

  const isHighlightedLink = (l: GraphLink): boolean => {
    if (!activeId) return false;
    return endId(l.source) === activeId || endId(l.target) === activeId;
  };

  // New dataset: reset framing + force flags and apply forces.
  useEffect(() => {
    didFitRef.current = false;
    forcesAppliedRef.current = false;
    configureForces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Settings changed (slider drag): re-apply forces live and reheat, but don't re-fit.
  useEffect(() => {
    configureForces();
    fgRef.current?.d3ReheatSimulation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={data}
      backgroundColor="#0a0f1a"
      d3VelocityDecay={settings.velocityDecay}
      cooldownTicks={120}
      onEngineTick={() => {
        // Safety net: if the ref attached after the effect ran (dynamic import),
        // apply forces on the first tick of this dataset's simulation.
        if (!forcesAppliedRef.current) configureForces();
      }}
      onEngineStop={() => {
        if (!didFitRef.current && fgRef.current) {
          didFitRef.current = true;
          fgRef.current.zoomToFit(400, 80);
        }
      }}
      // ---- node bubble (circle only — never a card, at any zoom) ----
      nodeCanvasObject={(node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const n = node as GraphNode;
        const active = activeId != null;
        const highlighted = isHighlightedNode(n.id);
        const isSelected = n.id === selectedId;
        const r = n.radius;

        ctx.globalAlpha = active && !highlighted ? 0.15 : 1;

        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
        ctx.fillStyle = n.color;
        ctx.fill();

        // selection ring
        if (isSelected) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // name label on hover (or for the selected node)
        if (n.id === hoveredId || isSelected) {
          const text = n.props?.name ?? n.label;
          const fontSize = Math.max(11 / globalScale, 3);
          ctx.font = `${fontSize}px ui-monospace, monospace`;
          ctx.fillStyle = "#e2e8f0";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(String(text), (n.x ?? 0) + r + 3, n.y ?? 0);
        }

        ctx.globalAlpha = 1;
      }}
      // accurate circular click target matching the drawn bubble
      nodePointerAreaPaint={(node: object, color: string, ctx: CanvasRenderingContext2D) => {
        const n = node as GraphNode;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, n.radius, 0, 2 * Math.PI);
        ctx.fill();
      }}
      // ---- edges ----
      linkColor={(link: object) =>
        isHighlightedLink(link as GraphLink) ? EDGE_HIGHLIGHT_COLOR : EDGE_COLOR
      }
      linkWidth={(link: object) => (isHighlightedLink(link as GraphLink) ? 1.5 : 0.5)}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
      // ---- interaction ----
      onNodeHover={(node: object | null) => setHoveredId(node ? (node as GraphNode).id : null)}
      onNodeClick={(node: object) => onNodeClick(node as GraphNode)}
      onBackgroundClick={onBackgroundClick}
      enableNodeDrag={true}
      minZoom={0.2}
      maxZoom={12}
    />
  );
};
