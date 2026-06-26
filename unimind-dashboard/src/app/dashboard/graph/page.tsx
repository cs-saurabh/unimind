"use client";

import React, { useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useGraphData } from "./hooks/useGraphData";
import { GraphCanvas } from "./components/GraphCanvas";
import { GraphLegend } from "./components/GraphLegend";
import { NodePropertiesPanel } from "./components/NodePropertiesPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { DEFAULT_SETTINGS, ForceSettings } from "./lib/forceSettings";
import { GraphNode } from "./types";

export default function GraphPage() {
  const { data, loading, error, limit, refetch } = useGraphData();
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [settings, setSettings] = useState<ForceSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleNodeClick = (node: GraphNode) => {
    setSettingsOpen(false); // node panel and settings share the right slot
    setSelected(node);
  };
  const handleBackgroundClick = () => setSelected(null);

  const handleApplyLimit = (newLimit: number) => {
    setSelected(null);
    refetch(newLimit);
  };

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="overflow-hidden">
        <div style={{ position: "relative", height: "100vh", width: "100%", overflow: "hidden" }}>
          <GraphLegend
            data={data}
            limit={limit}
            loading={loading}
            onApplyLimit={handleApplyLimit}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {!loading && !error && data.nodes.length > 0 && (
            <GraphCanvas
              data={data}
              selectedId={selected?.id ?? null}
              settings={settings}
              onNodeClick={handleNodeClick}
              onBackgroundClick={handleBackgroundClick}
            />
          )}

          {/* Loading overlay */}
          {loading && <Centered>Loading graph…</Centered>}

          {/* Empty state */}
          {!loading && !error && data.nodes.length === 0 && (
            <Centered>No nodes found.</Centered>
          )}

          {/* Error banner */}
          {error && (
            <div
              style={{
                position: "absolute",
                top: "60px",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 30,
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "10px 16px",
                backgroundColor: "#7f1d1d",
                border: "1px solid #b91c1c",
                borderRadius: "6px",
                color: "#fecaca",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "12px",
              }}
            >
              <span>{error}</span>
              <button
                onClick={() => refetch(limit)}
                style={{
                  padding: "3px 10px",
                  backgroundColor: "#b91c1c",
                  border: "none",
                  borderRadius: "4px",
                  color: "#fff",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Retry
              </button>
            </div>
          )}

          <NodePropertiesPanel node={selected} onClose={() => setSelected(null)} />

          <SettingsPanel
            open={settingsOpen}
            settings={settings}
            onChange={setSettings}
            onClose={() => setSettingsOpen(false)}
          />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#0a0f1a",
      color: "#64748b",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "14px",
    }}
  >
    {children}
  </div>
);
