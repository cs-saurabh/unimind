/**
 * UniMind memory graph — schema reference.
 *
 * Helix is schema-on-write for labels/properties; only INDEXES are explicit
 * (created in bootstrap.ts). This file is the single source of truth for label
 * names, edge names, and the property shape of each — mirroring handoff §6 mapped
 * onto the tenant-safe canonical model (helix-memory-system skill).
 *
 * Frozen-decision anchors:
 *   §5.4 type drives conflict + decay (primaryType + tags), not rigid buckets
 *   §5.5 relational memories are EDGES (REL, Entity→Entity); the other five are Memory nodes
 *   §5.6 supersede, never destroy (validFrom/validTo, isLatest) — contextual is the TTL exception
 *   §6   every memory/edge attaches to a canonical Entity node, never a raw mention
 */

// ---- label / edge name constants (use these, never string literals elsewhere) ----
export const L = {
  Entity: "Entity",
  Memory: "Memory",
  Category: "Category",
  Session: "Session",
} as const;

export const E = {
  MENTIONS: "MENTIONS", // Memory -> Entity   {tenant_id, role}
  REL: "REL", // Entity -> Entity   {tenant_id, predicate, weight, validFrom, validTo, createdAt}  (relational memory, §5.5)
  UPDATES: "UPDATES", // Memory -> Memory   {tenant_id, reason, at}            (supersede, §5.6)
  EXTENDS: "EXTENDS", // Memory -> Memory   {tenant_id, confidence, at}        (enrich)
  DERIVES: "DERIVES", // Memory -> Memory   {tenant_id, confidence, at}        (inferred)
  IN_CATEGORY: "IN_CATEGORY", // Memory -> Category {tenant_id, confidence}
  DERIVED_FROM: "DERIVED_FROM", // Memory -> Session  {tenant_id}              (provenance)
} as const;

// ---- the six memory types (§4): primaryType on a Memory node; relational lives on REL edges ----
export type PrimaryType = "EPISODIC" | "SEMANTIC" | "PROCEDURAL" | "CONTEXTUAL" | "GOAL";
export type EntityType = "person" | "org" | "project" | "concept";
export type GoalStatus = "active" | "completed" | "abandoned";

// ---- property shapes (documentation + worker type-safety) ----

/** Canonical entity — one node per real-world thing. Memories/edges attach here. */
export interface EntityNode {
  entityKey: string; // `${tenant_id}:${normalizedName}` — unique
  tenant_id: string;
  name: string; // canonical_name
  entityType: EntityType;
  aliases: string[]; // every surface form seen
  aliasText: string; // aliases joined — BM25-searchable for entity-linking candidate fetch
  embedding: number[]; // desc_embedding, F32[EMBED_DIM]
  confidence: number;
  createdAt: string; // RFC3339
  updatedAt: string;
}

/** Episodic / semantic / procedural / contextual / goal memory. */
export interface MemoryNode {
  memoryId: string; // unique (uuid)
  tenant_id: string;
  userId: string;
  primaryType: PrimaryType;
  tags: string[];
  content: string;
  embedding: number[]; // content_embedding, F32[EMBED_DIM]
  weight: number; // ranking + reinforcement signal (§5.11)
  confidence: number;
  isLatest: boolean; // recall filters to true
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string; // bumped on reinforcement
  accessCount: number;
  validFrom: string; // bitemporal validity (§5.6)
  validTo?: string | null; // set when superseded
  expiresAt?: string | null; // CONTEXTUAL TTL sweep target (§4 — only hard-deleted type)
  deletedAt?: string | null; // soft-delete tombstone
  decayPolicy: string; // e.g. "slow" | "evergreen" | "fast" | "goal-lifecycle"
  status?: GoalStatus | null; // GOAL only
  sourceSessionId?: string | null; // provenance
}

export interface CategoryNode {
  categoryKey: string; // `${tenant_id}:${normalizedName}` — unique
  tenant_id: string;
  name: string;
}

export interface SessionNode {
  sessionId: string; // unique
  tenant_id: string;
  userId: string;
  project?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export const normalizeKey = (tenant: string, name: string) =>
  `${tenant}:${name.trim().toLowerCase().replace(/\s+/g, " ")}`;
