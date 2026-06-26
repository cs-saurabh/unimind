"use client";

import React, { useMemo, useState } from "react";
import { Settings } from "lucide-react";
import { GraphData } from "../types";
import { nodeColor } from "../lib/colors";

interface Props {
  data: GraphData;
  limit: number;
  loading: boolean;
  onApplyLimit: (limit: number) => void;
  onOpenSettings: () => void;
}

export const GraphLegend: React.FC<Props> = ({
  data,
  limit,
  loading,
  onApplyLimit,
  onOpenSettings,
}) => {
  const [input, setInput] = useState(String(limit));

  // Only show node types actually present, with their counts.
  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of data.nodes) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const apply = () => {
    const n = Number(input);
    if (Number.isFinite(n) && n > 0) onApplyLimit(Math.floor(n));
  };

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
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        {legend.map(([label, count]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "50%",
                backgroundColor: nodeColor(label),
                display: "inline-block",
              }}
            />
            <span>
              {label} <span style={{ color: "#64748b" }}>({count})</span>
            </span>
          </div>
        ))}
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
