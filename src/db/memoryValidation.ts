import {
  MEMORY_BASES,
  MEMORY_KINDS,
  STALENESS_FLAGS,
  type MemoryNode,
} from "./schema.js";

export interface MemoryValidationDeps {
  existingMemoryIds?: (memoryIds: string[]) => Promise<Set<string>>;
  now?: Date;
}

export interface MemoryValidationResult {
  ok: boolean;
  reasons: string[];
}

const KIND_SET = new Set<string>(MEMORY_KINDS);
const BASIS_SET = new Set<string>(MEMORY_BASES);
const STALENESS_SET = new Set<string>(STALENESS_FLAGS);

export async function validateMemoryNode(
  node: MemoryNode,
  deps: MemoryValidationDeps = {},
): Promise<MemoryValidationResult> {
  const reasons: string[] = [];
  const nowMs = deps.now?.getTime() ?? Date.now();

  if (node.kind != null && !KIND_SET.has(node.kind)) {
    reasons.push(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  }
  if (node.basis != null && !BASIS_SET.has(node.basis)) {
    reasons.push(`basis must be one of ${MEMORY_BASES.join(", ")}`);
  }
  if (node.stalenessFlag != null && !STALENESS_SET.has(node.stalenessFlag)) {
    reasons.push(`stalenessFlag must be one of ${STALENESS_FLAGS.join(", ")}`);
  }

  if (node.primaryType === "EPISODIC" || node.primaryType === "GOAL") {
    if (node.kind != null) reasons.push(`${node.primaryType} memories cannot set kind`);
  }

  if (node.kind === "synthetic") {
    if (node.primaryType !== "SEMANTIC" && node.primaryType !== "PROCEDURAL") {
      reasons.push("synthetic memories must be SEMANTIC or PROCEDURAL");
    }
    if (!node.derivedFrom?.length) {
      reasons.push("synthetic memories must include at least one derivedFrom memoryId");
    }
  }

  if (node.kind === "knowledge_gap") {
    if (node.primaryType !== "CONTEXTUAL") {
      reasons.push("knowledge_gap memories must be CONTEXTUAL");
    }
    if (!node.expiresAt) {
      reasons.push("knowledge_gap memories must set expiresAt");
    }
  }

  if (node.freshness != null) {
    if (!Number.isFinite(node.freshness) || node.freshness < 0 || node.freshness > 1) {
      reasons.push("freshness must be a finite number between 0 and 1");
    }
  }

  if (node.lastRevisedAt != null) {
    const revisedAtMs = Date.parse(node.lastRevisedAt);
    if (!Number.isFinite(revisedAtMs)) {
      reasons.push("lastRevisedAt must be a valid RFC3339 timestamp");
    } else if (revisedAtMs > nowMs) {
      reasons.push("lastRevisedAt cannot be in the future");
    }
  }

  const contradictions = node.contradictions ?? [];
  if (node.hasContradiction === true && contradictions.length === 0) {
    reasons.push("hasContradiction=true requires at least one contradiction record");
  }
  if (contradictions.length > 0 && node.hasContradiction !== true) {
    reasons.push("contradictions require hasContradiction=true");
  }

  const referencedIds = new Set<string>();
  contradictions.forEach((entry, index) => {
    if (!entry?.withMemoryId?.trim()) {
      reasons.push(`contradictions[${index}].withMemoryId is required`);
    } else {
      referencedIds.add(entry.withMemoryId.trim());
    }

    const confidence = entry?.confidence;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      reasons.push(`contradictions[${index}].confidence must be between 0 and 1`);
    }

    if (!entry?.resolution?.trim()) {
      reasons.push(`contradictions[${index}].resolution is required`);
    }

    if (!Number.isFinite(Date.parse(entry?.resolvedAt ?? ""))) {
      reasons.push(`contradictions[${index}].resolvedAt must be a valid RFC3339 timestamp`);
    }
  });

  if (deps.existingMemoryIds && referencedIds.size > 0) {
    const found = await deps.existingMemoryIds([...referencedIds]);
    for (const id of referencedIds) {
      if (!found.has(id)) reasons.push(`contradictions reference missing memoryId "${id}"`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
