"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { GraphData, GraphNode } from "../types";
import {
  contradictionNote,
  contradictionTargets,
  gapPriority,
  gapStatus,
  gapTopic,
  gaugeValue,
  hasGapMarker,
  hasSyntheticMarker,
  isMemoryNode,
  memoryKind,
  memoryPrimaryType,
  memoryTitle,
  relatedNodesByEdge,
  suggestedPrompts,
} from "../lib/intelligence";
import { MARKER_COLORS } from "../lib/colors";

interface AuditRow {
  id: number;
  ts: string;
  category: string;
  actor: string;
  status: string;
  summary: string;
  details: Record<string, unknown> | null;
}

interface Props {
  node: GraphNode | null;
  data: GraphData;
  onClose: () => void;
  onSelectNode: (node: GraphNode) => void;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function auditQuery(node: GraphNode): string | null {
  const props = node.props ?? {};
  return props.memoryId ?? props.entityKey ?? props.sessionId ?? props.categoryKey ?? null;
}

function relatedThemeNodes(node: GraphNode, data: GraphData): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const related of relatedNodesByEdge(node, data, "RELATED_TO_THEME")) byId.set(related.id, related);
  for (const related of relatedNodesByEdge(node, data, "ADDRESSES_GAP")) byId.set(related.id, related);
  return [...byId.values()];
}

function propertyEntries(node: GraphNode): Array<[string, unknown]> {
  return Object.entries(node.props).filter(([key]) => key !== "id" && key !== "label");
}

const MEMORY_PILL_DEFINITIONS: Record<string, string> = {
  EPISODIC: "A specific past event or conversation moment; immutable history.",
  SEMANTIC: "A durable fact, preference, pattern, or abstract knowledge that can evolve over time.",
  PROCEDURAL: "A how-to, technique, workflow, or best practice.",
  CONTEXTUAL: "Short-lived current state tied to an active task or recent situation.",
  GOAL: "An active or tracked objective, plan, or desired outcome.",
  synthetic: "A memory created by the daily synthesis-sweep cron job from other memories.",
  knowledge_gap: "A temporary placeholder for a missing recorded stance on a recurring topic.",
  contradiction: "This memory is flagged as disagreeing with another memory; shown neutrally, with no winner chosen.",
};

export const NodePropertiesPanel: React.FC<Props> = ({ node, data, onClose, onSelectNode }) => {
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    const q = node ? auditQuery(node) : null;
    if (!q) {
      setAuditRows([]);
      setAuditError(null);
      setAuditLoading(false);
      return;
    }

    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);

    fetch(`/api/audit-logs?limit=6&q=${encodeURIComponent(String(q))}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || json.error) throw new Error(json.error || `Audit request failed (${res.status})`);
        if (!cancelled) setAuditRows(Array.isArray(json.rows) ? json.rows : []);
      })
      .catch((error: unknown) => {
        if (!cancelled) setAuditError(error instanceof Error ? error.message : "Failed to load audit trail");
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [node]);

  const derivedSources = useMemo(() => {
    if (!node) return [];
    return relatedNodesByEdge(node, data, "SYNTHESIZED_FROM");
  }, [data, node]);

  const contradictionNodes = useMemo(() => {
    if (!node) return [];
    return contradictionTargets(node, data);
  }, [data, node]);

  const relatedGapNodes = useMemo(() => {
    if (!node) return [];
    return relatedThemeNodes(node, data);
  }, [data, node]);

  if (!node) return null;

  const primaryType = memoryPrimaryType(node);
  const kind = memoryKind(node);
  const note = contradictionNote(node);
  const prompts = suggestedPrompts(node);
  const entries = propertyEntries(node);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        height: "100%",
        width: "390px",
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
              backgroundColor: node.color,
              flexShrink: 0,
            }}
          />
          <span style={{ color: "#e2e8f0", fontWeight: 600, fontSize: "13px", lineHeight: 1.3 }}>
            {isMemoryNode(node) ? memoryTitle(node) : node.label}
          </span>
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
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px 24px", display: "flex", flexDirection: "column", gap: "14px" }}>
        <Section title="Node">
          <PropertyRow label="Graph ID" value={node.id} accent="#67e8f9" />
          <PropertyRow label="Label" value={node.label} />
        </Section>

        {isMemoryNode(node) && (
          <>
            <Section title="Memory Intelligence">
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                {primaryType && (
                  <Pill
                    label={primaryType}
                    color={node.color}
                    tooltip={MEMORY_PILL_DEFINITIONS[primaryType]}
                  />
                )}
                {kind && (
                  <Pill
                    label={kind}
                    color={kind === "knowledge_gap" ? MARKER_COLORS.gap : MARKER_COLORS.synthetic}
                    text="#0f172a"
                    tooltip={MEMORY_PILL_DEFINITIONS[kind]}
                  />
                )}
                {node.props?.hasContradiction === true && (
                  <Pill
                    label="contradiction"
                    color={MARKER_COLORS.contradiction}
                    tooltip={MEMORY_PILL_DEFINITIONS.contradiction}
                  />
                )}
              </div>
              <div
                style={{
                  backgroundColor: "#111827",
                  border: "1px solid #1f2937",
                  borderRadius: "10px",
                  padding: "12px",
                  color: "#e2e8f0",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.5,
                }}
              >
                {typeof node.props?.content === "string" ? node.props.content : "No memory text"}
              </div>
            </Section>

            <Section title="Quality">
              <Gauge label="Confidence" value={gaugeValue(node.props?.confidence)} />
              <Gauge label="Freshness" value={gaugeValue(node.props?.freshness)} />
              <PropertyRow label="Basis" value={typeof node.props?.basis === "string" ? node.props.basis : "—"} />
              <PropertyRow label="Staleness" value={typeof node.props?.stalenessFlag === "string" ? node.props.stalenessFlag : "—"} />
            </Section>

            {hasSyntheticMarker(node) && (
              <Section title="Synthetic Sources">
                {derivedSources.length === 0 ? (
                  <EmptyHint>Source memories are not loaded in this graph sample.</EmptyHint>
                ) : (
                  derivedSources.map((source) => (
                    <NodeLinkButton key={source.id} node={source} onSelectNode={onSelectNode} />
                  ))
                )}
              </Section>
            )}

            {node.props?.hasContradiction === true && (
              <Section title="Contradictions">
                {note && (
                  <div
                    style={{
                      padding: "10px 12px",
                      borderRadius: "10px",
                      border: "1px solid rgba(239,68,68,0.35)",
                      backgroundColor: "rgba(127,29,29,0.25)",
                      color: "#fecaca",
                      lineHeight: 1.5,
                    }}
                  >
                    {note}
                  </div>
                )}
                {contradictionNodes.length === 0 ? (
                  <EmptyHint>Conflicting memory nodes are not loaded in this graph sample.</EmptyHint>
                ) : (
                  contradictionNodes.map((conflict) => (
                    <NodeLinkButton key={conflict.id} node={conflict} onSelectNode={onSelectNode} />
                  ))
                )}
              </Section>
            )}

            {hasGapMarker(node) && (
              <Section title="Gap Details">
                <PropertyRow label="Topic" value={gapTopic(node) ?? "—"} />
                <PropertyRow label="Priority" value={gapPriority(node) ?? "—"} />
                <PropertyRow label="Status" value={gapStatus(node) ?? "—"} />
                {prompts.length > 0 && (
                  <div>
                    <SmallLabel>Suggested prompts</SmallLabel>
                    <ul style={{ color: "#e2e8f0", margin: "6px 0 0 18px", lineHeight: 1.5 }}>
                      {prompts.map((prompt) => <li key={prompt}>{prompt}</li>)}
                    </ul>
                  </div>
                )}
                {relatedGapNodes.length > 0 && (
                  <div>
                    <SmallLabel>Related memories</SmallLabel>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
                      {relatedGapNodes.map((related) => (
                        <NodeLinkButton key={related.id} node={related} onSelectNode={onSelectNode} />
                      ))}
                    </div>
                  </div>
                )}
              </Section>
            )}
          </>
        )}

        <Section title="Audit Trail">
          {auditLoading ? (
            <EmptyHint>Loading audit events…</EmptyHint>
          ) : auditError ? (
            <EmptyHint>{auditError}</EmptyHint>
          ) : auditRows.length === 0 ? (
            <EmptyHint>No matching audit events found.</EmptyHint>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {auditRows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "10px",
                    border: "1px solid #1f2937",
                    backgroundColor: "#0b1220",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", color: "#94a3b8", fontSize: "11px" }}>
                    <span>{row.category}</span>
                    <span>{fmtTime(row.ts)}</span>
                  </div>
                  <div style={{ color: "#e2e8f0", marginTop: "6px", lineHeight: 1.45 }}>{row.summary}</div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="All Properties">
          {entries.length === 0 ? (
            <EmptyHint>No properties available.</EmptyHint>
          ) : (
            entries.map(([key, value]) => (
              <div key={key} style={{ padding: "8px 0", borderBottom: "1px solid #1e293b" }}>
                <SmallLabel>{key}</SmallLabel>
                <pre
                  style={{
                    margin: 0,
                    color: typeof value === "number" ? "#fb923c" : "#e2e8f0",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: 1.45,
                    fontFamily: "inherit",
                    maxHeight: key.toLowerCase() === "aliases" ? "300px" : undefined,
                    overflow: key.toLowerCase() === "aliases" ? "scroll" : undefined,
                    paddingRight: key.toLowerCase() === "aliases" ? "8px" : undefined,
                  }}
                >
                  {formatValue(value)}
                </pre>
              </div>
            ))
          )}
        </Section>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <SmallLabel>{title}</SmallLabel>
    <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" }}>{children}</div>
  </div>
);

const SmallLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      color: "#94a3b8",
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
    }}
  >
    {children}
  </div>
);

const PropertyRow: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div>
    <SmallLabel>{label}</SmallLabel>
    <div style={{ color: accent ?? "#e2e8f0", marginTop: "4px", lineHeight: 1.45, wordBreak: "break-word" }}>
      {value}
    </div>
  </div>
);

const Pill: React.FC<{ label: string; color: string; text?: string; tooltip?: string }> = ({
  label,
  color,
  text,
  tooltip,
}) => {
  const pill = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 8px",
        borderRadius: "999px",
        backgroundColor: color,
        color: text ?? "#f8fafc",
        fontSize: "11px",
        textTransform: "lowercase",
        cursor: tooltip ? "help" : "default",
      }}
    >
      {label}
    </span>
  );

  if (!tooltip) return pill;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="max-w-64 rounded-lg border border-border/60 bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-lg"
        bgColor="bg-popover"
        fillColor="fill-popover"
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};

const Gauge: React.FC<{ label: string; value: number | null }> = ({ label, value }) => (
  <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <SmallLabel>{label}</SmallLabel>
      <span style={{ color: "#e2e8f0" }}>{value == null ? "N/A" : `${Math.round(value * 100)}%`}</span>
    </div>
    <div
      style={{
        marginTop: "6px",
        height: "8px",
        borderRadius: "999px",
        backgroundColor: "#1e293b",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${(value ?? 0) * 100}%`,
          height: "100%",
          background: value == null ? "#334155" : "linear-gradient(90deg, #22c55e 0%, #38bdf8 100%)",
        }}
      />
    </div>
  </div>
);

const EmptyHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ color: "#64748b", lineHeight: 1.45 }}>{children}</div>
);

const NodeLinkButton: React.FC<{ node: GraphNode; onSelectNode: (node: GraphNode) => void }> = ({ node, onSelectNode }) => (
  <button
    onClick={() => onSelectNode(node)}
    style={{
      width: "100%",
      textAlign: "left",
      border: "1px solid #1f2937",
      backgroundColor: "#0b1220",
      borderRadius: "10px",
      padding: "10px 12px",
      color: "#e2e8f0",
      cursor: "pointer",
      lineHeight: 1.45,
    }}
  >
    <div style={{ color: "#94a3b8", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>
      {node.label}
    </div>
    {memoryTitle(node)}
  </button>
);
