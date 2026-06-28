"use client";

import React, { useMemo, useState } from "react";
import { Settings } from "lucide-react";
import { GraphData, GraphHighlightFilter } from "../types";
import { MARKER_COLORS, MEMORY_PRIMARY_COLORS, nodeColor } from "../lib/colors";
import { markerCounts, memoryPrimaryType } from "../lib/intelligence";

interface Props {
  data: GraphData;
  limit: number;
  loading: boolean;
  onApplyLimit: (limit: number) => void;
  onOpenSettings: () => void;
  highlightFilter: GraphHighlightFilter | null;
  onHighlightFilterChange: (filter: GraphHighlightFilter | null) => void;
}

export const GraphLegend: React.FC<Props> = ({
  data,
  limit,
  loading,
  onApplyLimit,
  onOpenSettings,
  highlightFilter,
  onHighlightFilterChange,
}) => {
  const [input, setInput] = useState(String(limit));

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of data.nodes) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const memoryBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data.nodes) {
      if (node.label !== "Memory") continue;
      const primaryType = memoryPrimaryType(node) ?? "Unknown";
      counts.set(primaryType, (counts.get(primaryType) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const markerSummary = useMemo(() => markerCounts(data), [data]);
  const nonMemoryLegend = legend.filter(([label]) => label !== "Memory");
  const memoryCount = legend.find(([label]) => label === "Memory")?.[1] ?? 0;

  const apply = () => {
    const n = Number(input);
    if (Number.isFinite(n) && n > 0) onApplyLimit(Math.floor(n));
  };

  const legendItemStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    borderRadius: "999px",
    border: active ? "1px solid rgba(226,232,240,0.28)" : "1px solid transparent",
    backgroundColor: active ? "rgba(148,163,184,0.14)" : "transparent",
    cursor: "pointer",
    transition: "background-color 120ms ease, border-color 120ms ease",
  });

  const isActive = (filter: GraphHighlightFilter): boolean =>
    highlightFilter?.kind === filter.kind && highlightFilter?.value === filter.value;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 15,
        display: "flex",
        alignItems: "center",
        gap: "16px",
        flexWrap: "wrap",
        padding: "10px 16px",
        backgroundColor: "rgba(10,15,26,0.85)",
        borderBottom: "1px solid #1e293b",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
        color: "#cbd5e1",
        backdropFilter: "blur(4px)",
      }}
    >
      {/* Legend swatches */}
      <div style={{ display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap" }}>
        {memoryCount > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ color: "#94a3b8" }}>Memory</span>
            {memoryBreakdown.map(([primaryType, count]) => (
              <div
                key={primaryType}
                style={legendItemStyle(isActive({ kind: "memoryType", value: primaryType }))}
                onMouseEnter={() => onHighlightFilterChange({ kind: "memoryType", value: primaryType })}
                onMouseLeave={() => onHighlightFilterChange(null)}
              >
                <span
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    backgroundColor: MEMORY_PRIMARY_COLORS[primaryType as keyof typeof MEMORY_PRIMARY_COLORS] ?? "#94a3b8",
                    display: "inline-block",
                  }}
                />
                <span>
                  {primaryType} <span style={{ color: "#64748b" }}>({count})</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {nonMemoryLegend.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {nonMemoryLegend.map(([label, count]) => (
              <div
                key={label}
                style={legendItemStyle(isActive({ kind: "label", value: label }))}
                onMouseEnter={() => onHighlightFilterChange({ kind: "label", value: label })}
                onMouseLeave={() => onHighlightFilterChange(null)}
              >
                <span
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    backgroundColor: nodeColor({ label }),
                    display: "inline-block",
                  }}
                />
                <span>
                  {label} <span style={{ color: "#64748b" }}>({count})</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ color: "#94a3b8" }}>Markers</span>
          <Marker
            swatch="★"
            color={MARKER_COLORS.synthetic}
            label="Insight"
            count={markerSummary.synthetic}
            active={isActive({ kind: "marker", value: "synthetic" })}
            onMouseEnter={() => onHighlightFilterChange({ kind: "marker", value: "synthetic" })}
            onMouseLeave={() => onHighlightFilterChange(null)}
          />
          <Marker
            swatch="▢"
            color={MARKER_COLORS.gap}
            label="Gap"
            count={markerSummary.gap}
            active={isActive({ kind: "marker", value: "gap" })}
            onMouseEnter={() => onHighlightFilterChange({ kind: "marker", value: "gap" })}
            onMouseLeave={() => onHighlightFilterChange(null)}
          />
          <Marker
            swatch="●"
            color={MARKER_COLORS.contradiction}
            label="Contradiction"
            count={markerSummary.contradiction}
            active={isActive({ kind: "marker", value: "contradiction" })}
            onMouseEnter={() => onHighlightFilterChange({ kind: "marker", value: "contradiction" })}
            onMouseLeave={() => onHighlightFilterChange(null)}
          />
        </div>
      </div>

      <div style={{ color: "#64748b" }}>
        {data.nodes.length} nodes · {data.links.length} edges
      </div>

      {/* Limit control + settings */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{ color: "#64748b" }}>Max nodes</span>
        <input
          type="number"
          min={1}
          value={input}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
          style={{
            width: "84px",
            padding: "4px 8px",
            backgroundColor: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "4px",
            color: "#e2e8f0",
            fontFamily: "inherit",
            fontSize: "12px",
          }}
        />
        <button
          onClick={apply}
          disabled={loading}
          style={{
            padding: "4px 12px",
            backgroundColor: loading ? "#1e293b" : "#334155",
            border: "1px solid #475569",
            borderRadius: "4px",
            color: "#e2e8f0",
            cursor: loading ? "default" : "pointer",
            fontFamily: "inherit",
            fontSize: "12px",
          }}
        >
          Apply
        </button>

        <button
          onClick={onOpenSettings}
          title="Layout settings"
          aria-label="Layout settings"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "5px",
            marginLeft: "4px",
            backgroundColor: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: "4px",
            color: "#cbd5e1",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#cbd5e1")}
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
};

const Marker: React.FC<{
  swatch: string;
  color: string;
  label: string;
  count: number;
  active: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}> = ({
  swatch,
  color,
  label,
  count,
  active,
  onMouseEnter,
  onMouseLeave,
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "4px 8px",
      borderRadius: "999px",
      border: active ? "1px solid rgba(226,232,240,0.28)" : "1px solid transparent",
      backgroundColor: active ? "rgba(148,163,184,0.14)" : "transparent",
      cursor: "pointer",
      transition: "background-color 120ms ease, border-color 120ms ease",
    }}
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
  >
    <span style={{ color, fontSize: "13px", lineHeight: 1 }}>{swatch}</span>
    <span>
      {label} <span style={{ color: "#64748b" }}>({count})</span>
    </span>
  </div>
);
