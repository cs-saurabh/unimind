"use client";

import React from "react";
import {
  DEFAULT_SETTINGS,
  ForceSettings,
  SETTING_FIELDS,
} from "../lib/forceSettings";

interface Props {
  open: boolean;
  settings: ForceSettings;
  onChange: (settings: ForceSettings) => void;
  onClose: () => void;
}

export const SettingsPanel: React.FC<Props> = ({ open, settings, onChange, onClose }) => {
  if (!open) return null;

  const setField = (key: keyof ForceSettings, value: number) =>
    onChange({ ...settings, [key]: value });

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
        zIndex: 25, // above the node properties panel (20)
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
        <span style={{ color: "#e2e8f0", fontWeight: 600, fontSize: "13px" }}>
          Layout Settings
        </span>
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

      {/* Sliders */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {SETTING_FIELDS.map((f) => {
          const value = settings[f.key];
          return (
            <div key={f.key} style={{ padding: "12px 16px", borderBottom: "1px solid #1e293b" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  marginBottom: "6px",
                }}
              >
                <span style={{ color: "#cbd5e1", fontSize: "12px" }}>{f.label}</span>
                <span style={{ color: "#fb923c", fontSize: "12px" }}>{value}</span>
              </div>
              <input
                type="range"
                min={f.min}
                max={f.max}
                step={f.step}
                value={value}
                onChange={(e) => setField(f.key, Number(e.target.value))}
                style={{ width: "100%", accentColor: "#a78bfa", cursor: "pointer" }}
              />
              <div style={{ color: "#64748b", fontSize: "10px", marginTop: "4px", lineHeight: 1.4 }}>
                {f.hint}
              </div>
            </div>
          );
        })}
      </div>

      {/* Reset */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #1e293b", flexShrink: 0 }}>
        <button
          onClick={() => onChange({ ...DEFAULT_SETTINGS })}
          style={{
            width: "100%",
            padding: "8px",
            backgroundColor: "#334155",
            border: "1px solid #475569",
            borderRadius: "4px",
            color: "#e2e8f0",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: "12px",
          }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
};
