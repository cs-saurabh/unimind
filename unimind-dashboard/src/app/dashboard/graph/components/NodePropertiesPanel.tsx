"use client";

import React from "react";
import { GraphNode } from "../types";

// A field is treated as an embedding/vector if it's a long numeric array.
function isVectorField(value: unknown): boolean {
  return Array.isArray(value) && value.length > 8 && value.every((v) => typeof v === "number");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3) return `[${value.map(formatValue).join(", ")}]`;
    return `[${value.slice(0, 3).map(formatValue).join(", ")}, …+${value.length - 3}]`;
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

interface Props {
  node: GraphNode | null;
  onClose: () => void;
}

export const NodePropertiesPanel: React.FC<Props> = ({ node, onClose }) => {
  if (!node) return null;

  const { props, color, label } = node;
  const systemKeys = new Set(["id", "label"]);
  const entries = Object.entries(props).filter(([k]) => !systemKeys.has(k));
  const vectorFields = entries.filter(([, v]) => isVectorField(v));
  const regularFields = entries.filter(([, v]) => !isVectorField(v));

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        height: "100%",
        width: "340px",
        backgroundColor: "#0f172a",
        borderLeft: "1px solid #1e293b",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.5)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px",
          borderBottom: "1px solid #1e293b",
          backgroundColor: "#0a1120",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <div
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              backgroundColor: color,
              flexShrink: 0,
            }}
          />
          <span style={{ color: "#e2e8f0", fontWeight: 600, fontSize: "13px" }}>{label}</span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#64748b",
            fontSize: "16px",
            lineHeight: 1,
            padding: "2px 4px",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#94a3b8")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
        >
          ✕
        </button>
      </div>

      {/* ID row */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1e293b", flexShrink: 0 }}>
        <div style={labelStyle}>ID</div>
        <div style={{ color: "#67e8f9", wordBreak: "break-all", lineHeight: "1.4", fontSize: "11px" }}>
          {node.id}
        </div>
      </div>

      {/* Properties */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {regularFields.length === 0 && vectorFields.length === 0 && (
          <div style={{ color: "#475569", padding: "16px", textAlign: "center" }}>No properties</div>
        )}

        {regularFields.map(([key, value]) => (
          <div key={key} style={{ padding: "8px 16px", borderBottom: "1px solid #1e293b" }}>
            <div style={labelStyle}>{key}</div>
            <div
              style={{
                color: "#e2e8f0",
                wordBreak: "break-word",
                whiteSpace:
                  typeof value === "object" && !Array.isArray(value) ? "pre-wrap" : "normal",
                lineHeight: "1.5",
              }}
            >
              {typeof value === "boolean" ? (
                <span style={{ color: value ? "#4ade80" : "#f87171" }}>{formatValue(value)}</span>
              ) : typeof value === "number" ? (
                <span style={{ color: "#fb923c" }}>{formatValue(value)}</span>
              ) : (
                formatValue(value)
              )}
            </div>
          </div>
        ))}

        {vectorFields.length > 0 && (
          <div style={{ padding: "8px 16px" }}>
            <div style={{ ...labelStyle, marginBottom: "6px" }}>Vector Fields</div>
            {vectorFields.map(([key, value]) => (
              <div
                key={key}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "5px 0",
                  borderBottom: "1px solid #1e293b",
                }}
              >
                <span style={{ color: "#94a3b8" }}>{key}</span>
                <span
                  style={{
                    color: "#475569",
                    backgroundColor: "#1e293b",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    fontSize: "10px",
                  }}
                >
                  [{(value as number[]).length}]
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  color: "#94a3b8",
  fontSize: "10px",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginBottom: "4px",
};
