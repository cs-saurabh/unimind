"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { forceCollide, forceX, forceY } from "d3-force";
import { GraphData, GraphHighlightFilter, GraphLink, GraphNode } from "../types";
import { edgeStyle, EDGE_HIGHLIGHT_COLOR, MARKER_COLORS } from "../lib/colors";
import { ForceSettings } from "../lib/forceSettings";
import {
  hasContradictionMarker,
  hasGapMarker,
  hasSyntheticMarker,
  linkResolution,
  memoryPrimaryType,
  memoryTitle,
} from "../lib/intelligence";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// react-force-graph replaces link.source/target with node objects after the first
// tick; before that they are plain ids. Resolve either shape to an id.
function endId(end: string | GraphNode): string {
  return typeof end === "object" ? end.id : end;
}

function colorWithOpacity(hex: string, opacity = 1): string {
  if (!hex.startsWith("#") || (hex.length !== 7 && hex.length !== 4)) return hex;
  const expanded = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0");
  return `${expanded}${alpha}`;
}

interface GraphCanvasProps {
  data: GraphData;
  selectedId: string | null;
  highlightFilter: GraphHighlightFilter | null;
  settings: ForceSettings;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  data,
  selectedId,
  highlightFilter,
  settings,
  onNodeClick,
  onBackgroundClick,
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const didFitRef = useRef(false);
  const forcesAppliedRef = useRef(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);

  const scaledRadius = useCallback(
    (node: GraphNode) => Math.max(2.5, node.radius * settings.nodeSizeMultiplier),
    [settings.nodeSizeMultiplier],
  );

  const collisionRadius = useCallback(
    (node: GraphNode) => scaledRadius(node) + 6,
    [scaledRadius],
  );

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
    fg.d3Force(
      "collide",
      forceCollide<GraphNode>(collisionRadius).strength(0.95).iterations(2),
    );
    forcesAppliedRef.current = true;
  }, [collisionRadius, settings]);

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

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of data.nodes) map.set(node.id, node);
    return map;
  }, [data.nodes]);

  // The "active" node = selected (sticky) or hovered. Drives highlight/dim.
  const activeId = selectedId ?? hoveredId;

  const matchesFilter = useCallback((node: GraphNode): boolean => {
    if (!highlightFilter) return true;
    switch (highlightFilter.kind) {
      case "memoryType":
        return node.label === "Memory" && memoryPrimaryType(node) === highlightFilter.value;
      case "label":
        return node.label === highlightFilter.value;
      case "marker":
        if (node.label !== "Memory") return false;
        if (highlightFilter.value === "synthetic") return hasSyntheticMarker(node);
        if (highlightFilter.value === "gap") return hasGapMarker(node);
        return hasContradictionMarker(node);
      default:
        return true;
    }
  }, [highlightFilter]);

  const isHighlightedNode = (id: string): boolean => {
    const node = nodeById.get(id);
    const passesFilter = node ? matchesFilter(node) : true;
    if (highlightFilter && !passesFilter) return false;
    if (!activeId) return passesFilter;
    return id === activeId || (neighbors.get(activeId)?.has(id) ?? false);
  };

  const isHighlightedLink = (l: GraphLink): boolean => {
    const sourceNode = nodeById.get(endId(l.source));
    const targetNode = nodeById.get(endId(l.target));
    const passesFilter = !highlightFilter || (
      sourceNode != null &&
      targetNode != null &&
      matchesFilter(sourceNode) &&
      matchesFilter(targetNode)
    );
    if (!passesFilter) return false;
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
        const filterActive = highlightFilter != null;
        const r = scaledRadius(n);

        ctx.globalAlpha = (filterActive || active) && !highlighted ? 0.12 : 1;

        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
        ctx.fillStyle = n.color;
        ctx.fill();

        if (hasGapMarker(n)) {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = MARKER_COLORS.gap;
          ctx.lineWidth = 1.5;
          ctx.strokeRect((n.x ?? 0) - r - 3, (n.y ?? 0) - r - 3, (r + 3) * 2, (r + 3) * 2);
          ctx.restore();
        }

        if (hasContradictionMarker(n)) {
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, r + 2, 0, 2 * Math.PI);
          ctx.strokeStyle = MARKER_COLORS.contradiction;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        if (isSelected) {
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, r + 5, 0, 2 * Math.PI);
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        if (hasSyntheticMarker(n)) {
          const fontSize = Math.max(12 / globalScale, 4);
          ctx.font = `${fontSize}px ui-monospace, monospace`;
          ctx.fillStyle = MARKER_COLORS.synthetic;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("★", (n.x ?? 0) + r * 0.7, (n.y ?? 0) - r * 0.7);
        }

        // name label on hover (or for the selected node)
        if (n.id === hoveredId || isSelected) {
          const text = memoryTitle(n);
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
        ctx.arc(n.x ?? 0, n.y ?? 0, scaledRadius(n), 0, 2 * Math.PI);
        ctx.fill();
      }}
      // ---- edges ----
      linkColor={(link: object) => {
        const typed = link as GraphLink;
        const style = edgeStyle(typed.type);
        if (highlightFilter) {
          const sourceNode = nodeById.get(endId(typed.source));
          const targetNode = nodeById.get(endId(typed.target));
          const matches = sourceNode != null && targetNode != null && matchesFilter(sourceNode) && matchesFilter(targetNode);
          if (!matches) return colorWithOpacity(style.color, 0.08);
        }
        return isHighlightedLink(typed)
          ? EDGE_HIGHLIGHT_COLOR
          : colorWithOpacity(style.color, style.opacity ?? 1);
      }}
      linkWidth={(link: object) => {
        const typed = link as GraphLink;
        const style = edgeStyle(typed.type);
        if (highlightFilter) {
          const sourceNode = nodeById.get(endId(typed.source));
          const targetNode = nodeById.get(endId(typed.target));
          const matches = sourceNode != null && targetNode != null && matchesFilter(sourceNode) && matchesFilter(targetNode);
          if (!matches) return Math.max(style.width * 0.6, 0.25);
        }
        return isHighlightedLink(typed) ? Math.max(style.width + 0.8, 1.6) : style.width;
      }}
      linkLineDash={(link: object) => edgeStyle((link as GraphLink).type).dash ?? null}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
      linkHoverPrecision={10}
      linkDirectionalArrowColor={(link: object) => {
        const typed = link as GraphLink;
        return isHighlightedLink(typed)
          ? EDGE_HIGHLIGHT_COLOR
          : edgeStyle(typed.type).color;
      }}
      linkCanvasObjectMode={(link: object) => ((link as GraphLink).id === hoveredLinkId ? "after" : undefined)}
      linkCanvasObject={(link: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const typed = link as GraphLink;
        if (typed.id !== hoveredLinkId || typed.type !== "CONTRADICTS") return;
        const resolution = linkResolution(typed);
        if (!resolution) return;
        const source = typed.source as GraphNode;
        const target = typed.target as GraphNode;
        if (typeof source !== "object" || typeof target !== "object") return;

        const x = ((source.x ?? 0) + (target.x ?? 0)) / 2;
        const y = ((source.y ?? 0) + (target.y ?? 0)) / 2;
        const fontSize = Math.max(11 / globalScale, 4);
        ctx.save();
        ctx.font = `${fontSize}px ui-monospace, monospace`;
        const text = resolution.length > 88 ? `${resolution.slice(0, 85)}...` : resolution;
        const width = ctx.measureText(text).width + 12 / globalScale;
        const height = fontSize + 10 / globalScale;
        ctx.fillStyle = "rgba(15,23,42,0.92)";
        ctx.strokeStyle = "rgba(239,68,68,0.85)";
        ctx.lineWidth = 1 / globalScale;
        ctx.beginPath();
        ctx.roundRect(x - width / 2, y - height / 2, width, height, 6 / globalScale);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#fecaca";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x, y);
        ctx.restore();
      }}
      // ---- interaction ----
      onNodeHover={(node: object | null) => setHoveredId(node ? (node as GraphNode).id : null)}
      onLinkHover={(link: object | null) => setHoveredLinkId(link ? (link as GraphLink).id : null)}
      onNodeClick={(node: object) => onNodeClick(node as GraphNode)}
      onBackgroundClick={onBackgroundClick}
      enableNodeDrag={true}
      minZoom={0.2}
      maxZoom={12}
    />
  );
};
