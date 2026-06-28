# UniMind Memory Intelligence Schema & Architecture

**Date:** June 27, 2026  
**Status:** Design Phase - Ready for Implementation Planning

---

## Executive Summary

This document defines the **Memory Intelligence Layer** for UniMind—a system that moves beyond passive memory storage and retrieval to **active, context-aware memory synthesis and injection**.

### Core Principle

> *A memory retrieval is not just stuffing some data into a session's context. It's injecting exactly what and how much the LLM needs based on the ongoing context.*

The Memory Intelligence Layer adds three capabilities:
1. **Synthesis** — Automatically extract patterns, insights, and contradictions from stored memories
2. **Selective Injection** — Retrieve only what's relevant to the current conversation task
3. **Gap Detection** — Identify missing knowledge and proactively surface it for future learning

---

## Part 1: Memory Schema

### 1.1 Memory Types (Unchanged)

Five core memory classifications remain:

| Type | Lifetime | Purpose | Mutability |
|------|----------|---------|-----------|
| **EPISODIC** | Forever | Specific conversational events | Immutable history |
| **SEMANTIC** | Until conflicted/stale | Abstract knowledge & patterns | Can be superseded |
| **PROCEDURAL** | Until approach changes | How-to knowledge & heuristics | Versioned changes |
| **CONTEXTUAL** | Short-lived (30d default) | Session/task-specific state | Expires + hard-delete |
| **GOAL** | Until achieved/abandoned | User goals & aspirations | Track evolution |

### 1.2 Memory Kind & Valid Combinations

A new `kind` property classifies memories by their origin/purpose. **Not all kinds are valid for all primaryTypes.**

#### Valid Kind-to-PrimaryType Mappings

| kind | Valid PrimaryTypes | Meaning |
|------|-------------------|---------|
| `synthetic` | SEMANTIC, PROCEDURAL | Created by synthesis sweep from other memories |
| `insight` | SEMANTIC | Discovered pattern or abstract principle |
| `heuristic` | SEMANTIC, PROCEDURAL | Rule of thumb or operational step |
| `preference` | SEMANTIC | User preference or stylistic choice |
| `antipattern` | SEMANTIC, PROCEDURAL | What to avoid |
| `knowledge_gap` | CONTEXTUAL only | Missing knowledge, temporary, short-lived |
| *(none/null)* | EPISODIC, GOAL | Raw historical events or goals (no kind) |

#### Validation Rules

```typescript
// Must enforce these constraints:
if (kind === "synthetic") {
  if (primaryType !== "SEMANTIC" && primaryType !== "PROCEDURAL") {
    throw new Error("synthetic memories must be SEMANTIC or PROCEDURAL");
  }
  if (!derivedFrom || derivedFrom.length === 0) {
    throw new Error("synthetic memories must have derivedFrom array");
  }
}

if (kind === "knowledge_gap") {
  if (primaryType !== "CONTEXTUAL") {
    throw new Error("knowledge_gap must be CONTEXTUAL");
  }
  if (!expiresAt) {
    throw new Error("knowledge_gap must have expiresAt TTL");
  }
}

if (primaryType === "EPISODIC" || primaryType === "GOAL") {
  if (kind !== null && kind !== undefined) {
    throw new Error("EPISODIC and GOAL memories cannot have a kind");
  }
}
```

#### Basis: How Was It Created?

Every memory tracks **basis** — the source/method of creation:
- **`direct_statement`** — User explicitly stated it (confidence: 0.75)
- **`pattern_analysis`** — Extracted from 5+ recurring episodes (confidence: 0.85, only for synthetic)
- **`entailment`** — Logically derived from stored facts (confidence: 0.72, only for synthetic). **Reserved for future — the entailment synthesis module is deferred to `FUTURE_ENHANCEMENT.md` (FE-1). The enum value is retained so no schema migration is needed when it is picked up.**
- **`conflict_resolution`** — Result of reconciling contradictions (confidence: 0.68-0.78, only for synthetic)

### 1.3 Core Memory Node Properties

**Updated MemoryNode interface** (adding new properties to current schema.ts):

```typescript
export interface MemoryNode {
  // --- Identity & Tenant (existing) ---
  memoryId: string;              // unique UUID
  tenant_id: string;
  userId: string;
  
  // --- Classification (existing + NEW) ---
  primaryType: "EPISODIC" | "SEMANTIC" | "PROCEDURAL" | "CONTEXTUAL" | "GOAL";
  tags: string[];                // existing: for categorization
  kind?: "synthetic" | "insight" | "heuristic" | "preference" | "antipattern" | "knowledge_gap";
  // NEW: semantic kind, optional, constrains primaryType (see validation rules below)
  
  // --- Content (existing) ---
  content: string;               // the memory text
  embedding: number[];           // F32[EMBED_DIM]
  
  // --- Confidence & Quality (existing + NEW) ---
  confidence: number;            // 0-1, set at creation, updated by synthesis (EXISTS on all memories)
  freshness?: number;            // NEW (OPTIONAL): 0-1, time-decay based, separate from confidence.
                                 // Old/un-migrated memories lack it → read coalesces to NEUTRAL (no penalty). See §3.3.
  basis?: "direct_statement" | "pattern_analysis" | "entailment" | "conflict_resolution";
  // NEW (OPTIONAL): how was this memory created? Old memories lack it → read coalesces to "direct_statement".
  // NOTE: ALL 8 new fields are OPTIONAL (lazy read-time defaults — no eager backfill; see plan Phase 1.4).
  
  // --- Derivation Tracking (NEW) ---
  derivedFrom?: string[];        // NEW: array of source memory IDs (for synthetic memories)
  costIfIgnored?: string;        // NEW: "4h debugging", "1 week refactor", etc (optional)
  
  // --- Contradiction Handling (NEW) ---
  hasContradiction?: boolean;    // NEW: does this contradict another memory?
  contradictions?: Array<{       // NEW: array of conflicts
    withMemoryId: string;
    resolution: string;          // explanation of how/why they conflict
    confidence: number;          // confidence in the resolution
    resolvedAt: string;          // RFC3339 timestamp
  }>;
  
  // --- Staleness & Lifecycle (existing + NEW) ---
  lastAccessedAt: string;        // existing: when retrieved from storage
  lastRevisedAt?: string;        // NEW: when content last changed/updated
  stalenessFlag?: "consider_refresh" | "needs_update" | null;  // NEW: marker from synthesis
  accessCount: number;           // existing: reinforcement signal
  weight: number;                // existing: ranking + reinforcement (§5.11)
  
  // --- Temporal Validity (existing) ---
  validFrom: string;             // RFC3339: when this version became valid
  validTo?: string | null;       // set when superseded (bitemporal versioning)
  isLatest: boolean;             // existing: recall filters to true
  
  // --- Lifecycle & Expiration (existing) ---
  createdAt: string;             // RFC3339
  updatedAt: string;             // last property change
  expiresAt?: string | null;     // CONTEXTUAL TTL sweep target (only type that hard-deletes)
  deletedAt?: string | null;     // soft-delete tombstone
  decayPolicy: string;           // existing: "slow" | "evergreen" | "fast" | "goal-lifecycle"
  
  // --- GOAL-specific (existing) ---
  status?: "active" | "completed" | "abandoned" | null;
  
  // --- Provenance (existing) ---
  sourceSessionId?: string | null;
}
```

**Summary of Changes:**
- ✅ Adds 9 new properties, **all OPTIONAL** (freshness, basis, derivedFrom, costIfIgnored, lastRevisedAt, stalenessFlag, kind, hasContradiction, contradictions). Optional because of lazy read-time defaults — existing memories genuinely lack them until written; reads coalesce to neutral defaults. No eager backfill.
- ✅ Reuses 11 existing properties (memoryId, content, embedding, confidence, weight, validFrom/validTo, isLatest, createdAt, updatedAt, expiresAt, deletedAt, etc)
- ✅ Fully backward compatible (new properties are optional or have defaults)

---

## Part 2: Synthesis & Derivation

### 2.1 The Synthesis Sweep (Daily @ 11 AM)

The synthesis sweep runs automatically once per day and performs four transformations on the memory graph:

#### Phase 1: Pattern Recognition
- **Input:** All EPISODIC and GOAL memories from the past N days
- **Process:** Cluster by theme (domain, entity, topic), detect recurring patterns
- **Output:** Create SEMANTIC "synthetic" memories for patterns seen 5+ times
- **Example:** 
  - Input: 10 separate episodes about async/sync choices
  - Output: SEMANTIC synthetic memory "User prefers async in Go" (confidence: 0.85)

#### Phase 2: Contradiction Detection (Flag Only)
- **Input:** All memories (especially SEMANTIC and PROCEDURAL)
- **Process:** Find genuine **stance reversals** (mind changed), NOT coexisting nuance. LLM judgment, biased toward not flagging. See Part 5.1.
- **Output:** Set `hasContradiction: true` + append `contradictions[]` note on both; draw a neutral `CONTRADICTS` edge. **No winner picked, no confidence change.**
- **Flag example:** "User prefers monorepos" → "User decided to use microservices for all future projects" ✅
- **Do-NOT-flag example:** "User prefers monorepos" + "monorepos are hard to navigate" ❌ (both can be true)

#### Phase 3: Gap Identification (NARROW trigger — decided during grilling)
- **Input:** Memory graph thematic clusters (the user's OWN memories only)
- **Trigger (bounded + conservative):** A gap fires **only** for a topic the user **keeps returning to in their own conversation history** (recurring across several memories/sessions) but for which **no SEMANTIC opinion/preference/stance is recorded**. The evidence must come from *within* existing memories — never from "topics that could theoretically relate to your expertise." When unsure, do NOT create the gap (fewer gaps, not more).
  - ✅ Fire: user repeatedly touches "monitoring" across sessions but never stated how they like to do it.
  - ❌ Don't fire: "expert in backend, zero memories on quantum computing" — never mentioned, so it's not a real gap.
- **Output:** Create CONTEXTUAL "gap" placeholder nodes
- **Anti-noise guards:**
  - **Cap** the number of open gaps (top N by priority) so injection/dashboard never floods.
  - **No-nag:** stop re-surfacing a gap after it has been shown a couple of times without being filled; let it quietly expire via the 30-day TTL instead of nagging on every read.
- **Properties:**
  - `priority`: "critical|high|medium|low" (based on related memory density)
  - `expiresAfter`: 30 days (or until filled)
  - `suggestedQuestions`: ["What's your take on X?", "How do you handle Y?"]
- **Example:**
  - Known: user mentions "monitoring/observability" across 6 memories in 4 sessions, always in passing
  - Known: 0 SEMANTIC memories recording the user's actual stance/approach to it
  - Output: CONTEXTUAL gap node "User's monitoring approach" with priority "high"

#### Phase 4: Confidence Decay
- **Input:** All non-CONTEXTUAL memories idle > 45 days (idle measured by `lastAccessedAt`, the same anchor as the existing maintenance sweeps)
- **Process:** Multiply confidence by 0.95 (gradual decay), floor 0.25
- **Guards:** Skip soft-deleted (`deletedAt != null`) and PROCEDURAL-evergreen memories
- **Output:** Update confidence, mark with `stalenessFlag: "consider_refresh"`
- **Rationale:** Memories become less reliable without recent validation

### 2.2 Synthesis Audit Trail

Every synthesis run creates **one** audit row **regardless of changes**, using the **existing `AuditInput` shape** from `src/audit/types.ts` (do NOT invent a new format). New category `CRON/synthesis`, `actor: "cron"`; the per-phase counts live in `details`:

```jsonc
{
  "category": "CRON/synthesis",      // NEW category to add to AuditCategory
  "actor": "cron",
  "status": "ok",                    // "ok" | "error" (partial failures still "ok" with per-phase notes)
  "summary": "synthesis sweep: 5 insights, 3 contradictions flagged, 2 gaps",
  "durationMs": 142000,
  "details": {
    "patterns_found": 8,
    "insights_created": 5,
    "insights_updated": 2,           // idempotency: update-in-place re-derivations (§2.1 Phase 1)
    "contradictions_flagged": 3,     // FLAG-ONLY (not "resolved" — we never pick a winner, §Part 5)
    "gaps_created": 2,
    "confidence_decayed": 12,        // synthesis Phase 4 — DISTINCT from the 04:00 CRON/decay (which decays weight)
    "validation_rejected": 1,        // memories skipped by validateMemoryNode() (§plan 1.5)
    "phase_status": { "pattern": "ok", "contradiction": "ok", "gap": "ok", "decay": "ok" }
  }
}
```

> **Note:** `ts`, `tenantId`, `userId` are filled in by `emit()` — callers don't pass them. This is one row per sweep (matches the existing "one row per logical cron operation" convention).

---

## Part 3: Read Pipeline & Selective Injection

### 3.1 The Recall Flow

When the LLM needs context (via hook or skill), the read pipeline executes:

#### Step 1: Conversation Analysis (System Infers Task)
- **Input:** Last N turns of conversation
- **Infer:** Task type and criticality
  - `task_type`: "coding|learning|decision|design|debugging|exploration"
  - `criticality`: "low|medium|high" (based on language signals and topic)
  - `injectionBudget`: adaptive TOKEN budget (~300 exploration / ~500 normal / ~800 decision), with a ~10-memory count backstop and a guaranteed min of 1 (see Step 5)

#### Step 2: Candidate Retrieval
- **Input:** Embedding of current context + inferred task type
- **Process:** Hybrid search (vector + BM25) on all non-deleted memories
- **Return:** Top 30 candidates ranked by raw relevance score

#### Step 3: Filtering & Ranking
Apply filters in order:
1. **Expiration:** Remove expired CONTEXTUAL memories
2. **Deletion:** Skip soft-deleted memories (deletedAt != null)
3. **Contradiction:** Do NOT remove (flag-only, Part 5) — contradicted memories stay and are annotated with the neutral note.
4. **Confidence:** For high-criticality tasks (criticality="high"), require confidence > 0.65
5. **Freshness:** Applied as a PENALTY-ONLY factor in ranking (§3.3) — stale memories demoted; missing freshness = neutral (no penalty), never a boost.

#### Step 4: Task-Aware Selection
Filter by task type:
- **coding** → prioritize PROCEDURAL (how-tos) + antipatterns (warnings)
- **learning** → prioritize EPISODIC (examples) + PROCEDURAL (step-by-step)
- **decision** → prioritize SEMANTIC (patterns) + gaps (missing knowledge)
- **debugging** → prioritize PROCEDURAL + costIfIgnored estimates
- **design** → prioritize SEMANTIC insights + contradictions (trade-offs)
- **exploration** → prioritize gaps + novel topics

#### Step 5: Selection (budget model decided during grilling)
- Select top memories by ranked score (the augmented `sim × recency × weight × priority × confidence/freshness` from §3.3).
- **Cut by an ADAPTIVE TOKEN BUDGET, not a raw count** — extends the existing `rankMemories(tokenBudget)` in `src/read/rank.ts`. The task guess sets the budget:
  - exploration / low criticality → ~300 tokens
  - normal / medium → ~500 tokens (current default)
  - decision / high criticality → ~800 tokens
- **Count backstop ~10**: never inject more than ~10 memories regardless of budget (stops a flood of tiny memories). This is where the plan's "1–10" lives — as a guard, not the primary dial.
- **Guarantee min 1**: always include the top memory if any relevant memory exists.
- Goals / current-state / relational facts keep their own small fixed slices (5 / 5 / 8) in `header.ts` — they are always-useful current state, separate from this relevant-memories budget.
- Sort by score (highest first).

> **Why token budget over count cap:** a "max 10" count is blunt — 10 long memories can blow context far more than 10 short ones. The token budget caps actual size; the task guess makes it adaptive. This keeps the codebase's principled size-based cost control while delivering the plan's adaptive intent.

### 3.2 Injection Format (decided during grilling — split by channel)

There are **two** delivery paths and they use **different** formats:

#### (a) Always-on header (the UserPromptSubmit hook) — COMPACT plain-text + minimal annotations

This block is injected on **every turn**, so it stays terse — extending today's `buildHeader()` plain-text format, NOT JSON. A clean memory is still one line; annotations appear **only when they change how the assistant should treat the memory**.

```
<unimind-memory>
Active goals:
- Move memories from file-based storage to Unimind
Current state:
- Working on the unimind project
Known relationships:
- Saurabh Pawar works at Contentstack
Relevant memories:
- User prefers async patterns in Go
- User preferred monorepos  ⚠ later chose microservices for all future projects — weigh by recency
- User uses Kubernetes on AWS for metering  [low confidence · unconfirmed 90d]
Knowledge gaps:
- No stated approach to monitoring/observability — consider asking
</unimind-memory>
```

Annotation rules:
| Annotation | Rendered as | Shown only when | Source |
|---|---|---|---|
| (default) | `- <content>` | always | the memory |
| Contradiction note | `⚠ <note> — weigh by recency` | `hasContradiction = true` | `contradictions[]` note (flag-only) |
| Caution tag | `[low confidence · unconfirmed 90d]` | low `confidence` OR `stalenessFlag` set | `confidence` + `freshness`/`stalenessFlag` |
| Knowledge gaps group | separate `Knowledge gaps:` block | 1–2 high-priority gaps (capped, no-nag) | CONTEXTUAL `kind:"knowledge_gap"` |

**Deliberately NOT in the header:** `memoryId`, `basis`, `derivedFrom` count, raw `freshness` number, `costIfIgnored`, `lastValidated`, `taskRelevance`. These are bookkeeping the assistant doesn't act on mid-turn — they live in the dashboard, the audit log, and the `recall()` tool output (below).

#### (b) On-demand `recall()` MCP tool — RICH structured output

When the assistant *explicitly* calls `recall()` for a deliberate deep dive (not every-turn), it may return the full structured form, since cost is one-off and the extra metadata aids a focused dig:

```json
{
  "memoryId": "memory:abc123",
  "type": "SEMANTIC",
  "kind": "insight",
  "text": "User prefers async patterns in Go",
  "metadata": {
    "confidence": 0.85, "freshness": 0.92, "basis": "pattern_analysis",
    "derivedFrom": 5, "costIfIgnored": "4h debugging",
    "lastValidated": "2026-06-20", "taskRelevance": "high"
  },
  "contradictions": [
    { "text": "User decided to use microservices for all future projects",
      "resolution": "Stance changed from monorepo preference", "confidence": 0.78 }
  ],
  "relatedGaps": [ { "topic": "async error handling patterns", "priority": "high" } ]
}
```

---

## Part 4: Gap Management

### 4.1 Gap Lifecycle

Gaps are first-class nodes in the memory graph using CONTEXTUAL memory type with `kind: "knowledge_gap"`.

**Creation:** Synthesis sweep identifies knowledge gaps and creates CONTEXTUAL memory nodes

**Gap Properties (on MemoryNode):**
```typescript
{
  // Standard MemoryNode properties
  memoryId: "memory:gap-xyz",
  tenant_id: string,
  userId: string,
  primaryType: "CONTEXTUAL",           // gaps are always CONTEXTUAL
  kind: "knowledge_gap",               // gap-specific kind
  content: "User's monitoring/observability approach",
  
  // Gap-specific metadata in tags array
  tags: ["gap:monitoring", "priority:high"],  // topic + priority encoded as tags
  
  // NEW: Intelligence Layer properties
  confidence: 0.5,                     // moderate confidence (speculative)
  freshness: 1.0,                      // high freshness (newly created)
  basis: "gap_detection",              // how it was identified
  
  // Tracking
  createdAt: "2026-06-27T11:00:00Z",
  expiresAt: "2026-07-27T11:00:00Z",   // 30-day TTL
  deletedAt: null,                     // null until closed/expired
  
  // Gap lifecycle
  weight: 0.8,                         // importance signal
  accessCount: 0,                      // bumps when surfaced to LLM
  lastAccessedAt: "2026-06-27T11:00:00Z",  // when last surfaced to LLM
  lastRevisedAt: "2026-06-27T11:00:00Z",   // when last confirmed
  
  // Gap status tracking
  status: "open|partially_addressed|closed",  // stored as tag or separate prop
  
  // Links to related memories
  // (via MENTIONS edge to Entity, or thematic edges to related memories)
}
```

**Gap-Specific Metadata:**

Gaps store operational metadata using tags array + standard MemoryNode fields:

| Info | Storage | Example |
|------|---------|---------|
| Topic | `tags[0]` | `"gap:monitoring"` |
| Priority | `tags[1]` | `"priority:high"` |
| Suggested Prompts | embedded in `content` or tags | JSON string in content field |
| Related Memories | via edge `RELATED_TO_THEME` | Links to SEMANTIC memories on topic |
| Status | `tags[2]` or computed from deletedAt | `"status:open"` |
| Closure Reason | `deletedAt` timestamp | Set when gap resolved |

### 4.2 Gap Surfacing

**In Read Pipeline:**
- When injecting memories for a "learning" or "exploration" task, include 1-2 high-priority gaps
- Gaps appear as: "Gap detected: User hasn't shared opinions on [topic]. Consider asking about [suggestedPrompts]."

**In Dashboard:**
- Display gaps as placeholder nodes with visual distinction
- Show priority levels, age, and related memories
- Allow manual closing (status: "closed")

**In Audit Logs:**
- Every gap creation logged
- Tracked when gaps are surfaced to LLM
- Tracked when gaps are filled (new memory created on that topic)

### 4.3 Gap Closure

A gap is considered "filled" when:
- New memory created on that topic (after gap was identified)
- Manual closure via dashboard
- 30-day expiration (auto-closes)

---

## Part 5: Contradiction Handling

> **Strategy decided during grilling: FLAG ONLY (no winner, no re-ranking).** The synthesis sweep records that two memories disagree plus a short reconciliation note, and surfaces that note when either is read. It does **NOT** pick an authoritative version and does **NOT** change either memory's confidence. This stays consistent with the codebase's existing "SEMANTIC: never destroy on contradiction — keep both" rule, and is purely additive on top of the existing EXTENDS/UPDATES behavior.

### 5.1 Contradiction Detection

Flag a contradiction only on a **genuine reversal of stance** — where the user has changed their mind — not on two statements that can comfortably coexist.

**Flag (genuine reversal):**
- "User prefers monorepos" → "User decided to use microservices for all future projects" ✅ (stance changed)

**Do NOT flag (coexisting nuance):**
- "User prefers monorepos" + "User said monorepos are hard to navigate" ❌ (both can be true at once; preference + acknowledged drawback is not a contradiction)

**Detection Criteria:**
- Same semantic topic/entity (via embedding similarity + keyword matching)
- **Mutually exclusive / opposite stance** — the new statement cannot be true at the same time as the old one (a change of decision/direction), not merely a caveat or trade-off
- Within same memory class (don't flag episodic vs semantic as contradiction)
- The detection is an LLM judgment call (the sweep's synthesis step); bias toward NOT flagging when the two statements could both hold.

### 5.2 Resolution Strategy (Flag Only)

**Keep both, mark both, pick no winner:**
- Both memories stay live (`isLatest=true`), exactly as the current SEMANTIC extend behavior already does.
- Set `hasContradiction: true` on both and append a `contradictions[]` record (the new MemoryNode fields) describing how they disagree.
- Draw a neutral `CONTRADICTS` edge between them carrying the reconciliation note.
- **No confidence change. No "authoritative" / "alternative" designation.** (The `RESOLVES_CONTRADICTION` and `has_alternative` edges are NOT used in v1 — they imply picking a winner. See Part 8.)

**Example contradiction record (stored in `contradictions[]` on each memory):**
```
{
  withMemoryId: "memory:xyz",
  resolution: "User changed direction: earlier preferred monorepos, later chose microservices for future projects",
  confidence: 0.78,          // confidence in the RECONCILIATION NOTE, not a re-rank of either memory
  resolvedAt: "2026-06-27T11:00:00Z"
}
```

### 5.3 Injection with a Neutral Note

When either memory is read, include the disagreement note so the assistant can weigh both itself — without the system having taken sides:

```json
{
  "text": "User preferred monorepos",
  "contradictionNote": "Later changed direction: chose microservices for future projects. Both recorded; weigh by recency/context.",
  "conflictsWith": [
    { "text": "User decided to use microservices for all future projects" }
  ]
}
```

This tells the assistant: "These two disagree — here's the note — you decide which applies."

---

## Part 6: Freshness & Confidence

### 6.1 Confidence Scores

Set by three sources:

**1. Initial Extraction (basis: direct_statement)**
- Explicit statement from user: 0.75
- Derived from single episode: 0.40

**2. Synthesis Sweep (basis: pattern_analysis | conflict_resolution)** — _(entailment deferred, see FUTURE_ENHANCEMENT.md FE-1)_
- Pattern seen 5+ times: 0.85 (basis: pattern_analysis)
- Pattern seen 3-4 times: 0.70 (basis: pattern_analysis)
- Conflict resolution (heuristic): 0.68-0.78 (basis: conflict_resolution)
- _(Entailment 0.72 deferred — see `FUTURE_ENHANCEMENT.md` FE-1)_

**3. Confidence Decay (ongoing)**
- Multiply by 0.95 for each 45-day idle period (via decayPolicy cron)
- Minimum floor: 0.25 (don't go to zero)

### 6.2 Freshness Score (Distinct from Confidence)

**Key distinction:** Confidence = "is this true?", Freshness = "is this still relevant/validated?"

Calculated independently from confidence; measures recency of use:

```
freshness = decay_factor * time_since_last_revised

decay_factor = 1.0 if lastRevisedAt < 7 days
             = 0.9 if lastRevisedAt < 30 days
             = 0.7 if lastRevisedAt < 90 days
             = 0.4 if lastRevisedAt > 90 days

time_since_last_revised = days_idle / 180 (sigmoid decay over 6 months)
```

#### Timestamp Distinctions

| Timestamp | Set When | Purpose |
|-----------|----------|---------|
| `lastAccessedAt` | Memory retrieved from storage (every read) | Access frequency signal |
| `lastRevisedAt` | Memory content updated OR synthesis confirmed it (weekly sweep) | Content validity signal |
| `createdAt` | Memory first stored | Immutable creation time |
| `updatedAt` | Any property changed | For debugging/audit trail |

**Example Timeline:**
- Day 1: User states "prefer async" → createdAt, lastRevisedAt, lastAccessedAt all = Day 1
- Day 5: User's message retrieved memory → lastAccessedAt = Day 5, but lastRevisedAt unchanged
- Day 8 (synthesis sweep): Pattern analysis confirms preference from 5+ episodes → lastRevisedAt = Day 8
- Day 30: Never accessed since Day 5 → confidence still 0.85, but freshness decays to ~0.6

**Result:** Memory can be high-confidence (0.85) but low-freshness (0.4) if it's true but unconfirmed for 90+ days. Read pipeline will deprioritize it for critical tasks.

---

## Part 7: Task Inference

### 7.1 Task Types

System infers one of six task types from conversation. The "Signals" column below are illustrative examples of intent, **not** a literal keyword-matching rule set (see §7.2).

| Task | Example intent | Memory Emphasis |
|------|---------|-----------------|
| **coding** | implementing, writing, refactoring, fixing a bug | PROCEDURAL, antipatterns |
| **learning** | how something works, teach/explain/understand | EPISODIC, PROCEDURAL examples |
| **decision** | should we, choosing, trade-offs, architecture calls | SEMANTIC insights, contradictions |
| **debugging** | why is this broken, errors, investigating | PROCEDURAL + cost estimates |
| **design** | designing, architecture, patterns, structure | SEMANTIC insights, related gaps |
| **exploration** | curious, exploring, what-if, experimenting | Gaps, novel connections |

### 7.2 Inferencing Method (decided during grilling)

Task type + criticality are inferred by the **existing single read-path LLM call** (the `planner` that already extracts topics + entities on every read) — task guessing is added to that call's output, **not** a separate keyword engine or extra LLM call.

- **Why:** an LLM reads mixed-signal sentences correctly ("why does my code break when I change the design?") where keyword matching gets confused; and since the read path already makes exactly one LLM call, this adds no extra latency or cost.
- **Nudge, not gate:** the guess only *adjusts* memory-type weighting in ranking. On low confidence, recall falls back to the current type-priority ranking unchanged — nothing breaks if the guess is wrong.

### 7.3 Criticality Inference

Based on conversation signals:

- **high:** decision keywords, architecture discussion, user expresses uncertainty
- **medium:** routine tasks, established patterns
- **low:** exploration, learning, casual inquiry

---

## Part 8: Graph Representation

### 8.1 Node Types in Knowledge Graph

**Important:** There are **no new node labels.** "Insight", "Contradiction", and "Gap" below are **not separate node types** — they are all regular **Memory** nodes distinguished by `kind` / properties. The only physical node labels remain Memory, Entity, Category, Session. The rows below are *conceptual roles*, not storage tables.

| Conceptual role | How it's actually stored | Connections |
|-----------|---------|-------------|
| **Memory** | Memory node (all 5 primaryTypes + kinds) | links to derived-from, contradicts, addresses_gap |
| **Insight** | Memory node with `kind: "synthetic"` (SEMANTIC/PROCEDURAL) | SYNTHESIZED_FROM → source memories |
| **Contradiction** | NOT a node — embedded `contradictions[]` + `hasContradiction` on the two Memory nodes, plus a `CONTRADICTS` edge | CONTRADICTS edge between the two memories |
| **Gap** | Memory node with `primaryType: "CONTEXTUAL"` + `kind: "knowledge_gap"` | RELATED_TO_THEME / ADDRESSES_GAP → relevant memories |
| **Entity** | Entity node (existing) | referenced_by → memories mentioning it |

### 8.2 Edge Types

**Existing edge types (from schema.ts):**
- `MENTIONS` — Memory → Entity (entity referenced in memory, metadata: {tenant_id, role})
- `REL` — Entity → Entity (relational memory, metadata: {tenant_id, predicate, weight, validFrom, validTo})
- `UPDATES` — Memory → Memory (supersede, metadata: {tenant_id, reason, at})
- `EXTENDS` — Memory → Memory (enrich, metadata: {tenant_id, confidence, at})
- `DERIVES` — Memory → Memory (inferred, metadata: {tenant_id, confidence, at})
- `IN_CATEGORY` — Memory → Category (categorization, metadata: {tenant_id, confidence})
- `DERIVED_FROM` — Memory → Session (provenance, metadata: {tenant_id})

**New edge types (for Memory Intelligence Layer):**
- `SYNTHESIZED_FROM` — Synthetic Memory → Source Memories (many-to-many, metadata: {tenant_id, confidence, basis})
  - Replaces/extends DERIVES for clarity on synthesis-generated insights
- `CONTRADICTS` — Memory → Memory (bidirectional, metadata: {tenant_id, resolution, confidence, resolvedAt})
  - Marks conflicting memories, stores resolution reasoning
- `RESOLVES_CONTRADICTION` — **NOT used in v1.** Implies picking an authoritative version; contradiction handling is flag-only (Part 5), so no winner is marked. Reserved for a future "take sides" mode.
- `ADDRESSES_GAP` — Memory → Gap (new memory fills a gap, metadata: {tenant_id, at})
  - Tracks when gaps are closed
- `RELATED_TO_THEME` — Memory → Memory (semantic clustering, metadata: {tenant_id, theme_name, weight})
  - Groups memories by synthesized themes

---

## Part 9: Audit Logging

All audit entries use the **existing `AuditInput` shape** (`category`, `actor`, `status`, `summary`, `details`) from `src/audit/types.ts` — `ts`/`tenantId`/`userId` are filled by `emit()`. The Intelligence Layer does NOT invent a new format; it **reuses existing categories** for reads and **adds one new category** for synthesis.

### 9.1 Read Operations — reuse existing categories, enrich `details`

The read path already logs `READ/inject` (hook auto-inject) and `READ/recall` (recall MCP tool). No new category — just put the new intelligence signals in `details`:

```jsonc
{
  "category": "READ/inject",         // existing
  "actor": "hook",
  "status": "ok",
  "summary": "injected 5 memories (decision task)",
  "details": {
    "task_type": "decision",         // NEW — from the folded-in planner guess
    "criticality": "high",           // NEW
    "token_budget": 800,             // NEW — adaptive budget used (not a 1-10 count)
    "injected_count": 5,
    "annotations": { "contradiction_notes": 1, "caution_tags": 1, "gaps_surfaced": 1 }  // NEW
  }
}
```

### 9.2 Synthesis Sweep Audit — one new category `CRON/synthesis`

See §2.2 for the full shape. Key points: `actor: "cron"`, one row per sweep, flag-only terminology (`contradictions_flagged`, not `_resolved`), idempotency counts (`insights_updated`), `validation_rejected`, and `confidence_decayed` kept DISTINCT from the existing `CRON/decay` (weight decay at 04:00).

**New `AuditCategory` value to add:** `"CRON/synthesis"`. No other categories change.

All audit entries visible in dashboard Audit Logs page.

---

## Part 10: Dashboard & User Visibility

> **Coloring model (decided during grilling):** nodes are colored by **`primaryType`** (mandatory on all memories → old memories always get a color, no missing-`kind` problem), with **additive overlay markers** for `kind: synthetic` (⭐ insight), `kind: knowledge_gap` (▢ gap), and `hasContradiction` (🔴). Markers are absent on ordinary memories. Legend shows a per-primaryType breakdown + a Markers sub-key + node/edge totals.

### 10.1 Memory Node Details Panel (rich — Option B)

The base panel is already generic (shows all node properties). The rich panel adds, when user clicks a memory node:
- Memory text
- primaryType + kind
- Confidence + freshness (with visual gauges; missing values degrade gracefully)
- Basis (how was it created?)
- Last used / last revised dates
- If `kind: synthetic`: Source memories (clickable)
- If `hasContradiction`: the conflicting memory + reconciliation note, shown **neutrally** (no winner/alternative framing — flag-only, Part 5)
- If `kind: knowledge_gap`: Status + suggested prompts + related memories
- Audit trail (when it was used, injected, revised)

### 10.2 Insights (overlay marker, not a separate node)

Synthetic memories (`kind: synthetic`) are Memory nodes with their primaryType base color **plus** a ⭐ gold marker:
- Marker: ⭐ gold badge/ring (NOT a different node label)
- Edges: SYNTHESIZED_FROM → sources ("derived from")
- Hoverable: Preview of source memories

### 10.3 Contradictions as Edges + Marker (flag-only)

- The two conflicting memories carry a 🔴 marker (`hasContradiction: true`)
- A `CONTRADICTS` edge between them shows red/dashed with the reconciliation note on hover
- Shown **neutrally** — no authoritative version; can toggle contradiction edges in/out of view

### 10.4 Gaps (overlay marker)

Gaps (`kind: knowledge_gap`, CONTEXTUAL) render with the CONTEXTUAL base color plus a ▢ gap marker:
- Grayed-out/placeholder styling + "Gap" marker + priority
- Hoverable: Show suggested questions
- On click: Show related memories and why the gap matters

---

## Part 11: Integration Points

### 11.1 Write Pipeline → Synthesis

1. Raw memory extracted and stored
2. Next synthesis sweep (11 AM) processes it
3. May create derived insights or mark contradictions
4. Updated memories available at next read

### 11.2 Synthesis → Read Pipeline

1. Synthesis creates/updates insights
2. Read pipeline available immediately (uses today's or yesterday's synthesis)
3. Injected memories include synthetic + contradictions + gaps

### 11.3 Read Pipeline → Audit

1. Every recall logs which memories were injected
2. Task type + criticality recorded
3. Memory confidence + freshness recorded
4. Dashboard tracks injection patterns

### 11.4 User Manual Actions

- **Dashboard:** Close gaps manually, mark memories stale
- **Conversation:** Implicit feedback (using vs ignoring injected memory)
- **Synthesis:** Next sweep incorporates manual actions (e.g., gap marked closed)

---

## Part 12: Success Metrics & Observability

### 12.1 What We Can Measure

- **Synthesis Impact:** # insights created/updated per sweep, # contradictions flagged, # validation rejections
- **Injection Quality:** % of injected memories actually used by LLM (via conversation continuation)
- **Gap Lifecycle:** Time-to-close per gap, which gaps stay longest
- **Confidence Accuracy:** Over time, does high-confidence memory correlate with LLM success?
- **Task Inference Accuracy:** Does inferred task type match actual user intent?
- **Freshness Value:** Do newer memories get used more?

### 12.2 Monitoring

Via audit logs visible in dashboard:
- Daily synthesis sweep results (# changes)
- Injection budget usage (adaptive tuning)
- Gap creation/closure rates
- Contradiction resolution trend
- Confidence distribution histograms

---

## Summary: Data Model Overview

### MemoryNode (Core Structure)

**Base Properties (from schema.ts, existing):**
```
├── memoryId (UUID, unique)
├── tenant_id, userId
├── primaryType (EPISODIC|SEMANTIC|PROCEDURAL|CONTEXTUAL|GOAL)
├── content (text)
├── embedding (F32[EMBED_DIM])
├── weight (0-10, ranking signal)
├── isLatest (boolean, recall filters)
├── tags (string[], categorization)
├── createdAt, updatedAt
├── lastAccessedAt (when retrieved)
├── accessCount (reinforcement)
├── validFrom / validTo (bitemporal versioning)
├── decayPolicy (slow|evergreen|fast|goal-lifecycle)
└── sourceSessionId (provenance)
```

**NEW Intelligence Layer Properties (added):**
```
├── kind? (synthetic|insight|heuristic|preference|antipattern|knowledge_gap)
├── confidence (0-1, updated by synthesis)
├── freshness (0-1, time-decay from lastRevisedAt)
├── basis (direct_statement|pattern_analysis|entailment|conflict_resolution)
├── derivedFrom? (array of source memory IDs for synthetic)
├── costIfIgnored? (string: "4h debugging", etc)
├── lastRevisedAt? (when content/meaning last changed)
├── stalenessFlag? (consider_refresh|needs_update|null)
├── hasContradiction (boolean)
└── contradictions (array of {withMemoryId, resolution, confidence, resolvedAt})
```

**CONTEXTUAL-Specific Properties:**
```
├── expiresAt (TTL, 30 days for gaps)
└── deletedAt (soft-delete timestamp)
```

**GOAL-Specific Properties:**
```
└── status (active|completed|abandoned)
```

### Gap Node (CONTEXTUAL Memory with kind="knowledge_gap")

```
MemoryNode {
  primaryType: "CONTEXTUAL"
  kind: "knowledge_gap"
  content: "User's monitoring/observability approach"
  tags: ["gap:monitoring", "priority:high", "status:open"]
  confidence: 0.5 (speculative)
  basis: "gap_detection"
  expiresAt: (30 days from creation)
  weight: 0.8 (importance)
  accessCount: (bumps when surfaced to LLM)
  lastAccessedAt: (when last offered to LLM)
  lastRevisedAt: (when last confirmed)
}
```

### Contradiction Record (stored in contradictions[] array)

```
{
  withMemoryId: "memory:xyz"
  resolution: "User changed direction: earlier preferred monorepos, later chose microservices for future projects"
  confidence: 0.78          // confidence in the reconciliation NOTE, not a re-rank of either memory
  resolvedAt: "2026-06-27T11:00:00Z"
}
```

**Both Versions Preserved (flag only, no winner):**
- Both memories stay live (`isLatest=true`), neither re-ranked
- Linked by a neutral `CONTRADICTS` edge carrying the note (no primary/alternative designation)

### Edge Types (in HelixDB Graph)

**Existing:**
- MENTIONS (Memory → Entity)
- REL (Entity → Entity, relational memory)
- UPDATES (Memory → Memory, supersede)
- EXTENDS (Memory → Memory, enrich)
- DERIVES (Memory → Memory, inferred)
- IN_CATEGORY (Memory → Category)
- DERIVED_FROM (Memory → Session)

**NEW (Intelligence Layer):**
- SYNTHESIZED_FROM (Synthetic Memory → Source Memories)
- CONTRADICTS (Memory ↔ Memory, bidirectional, carries reconciliation note)
- RESOLVES_CONTRADICTION (NOT used in v1 — reserved for future "take sides" mode)
- ADDRESSES_GAP (Memory → Gap)
- RELATED_TO_THEME (Memory → Memory, theme clustering)

### Audit Entry (uses the existing `AuditInput` shape — see §9)

```
{
  // ts / tenantId / userId are filled by emit()
  category: "READ/inject" | "READ/recall" | "CRON/synthesis" | ...(existing categories)
  actor: "hook" | "skill" | "cron" | "worker"
  status: "ok" | "error"
  summary: string
  durationMs: number | null
  details: {                       // free-form per category
    // READ/*: task_type, criticality, token_budget, injected_count, annotations{...}
    // CRON/synthesis: patterns_found, insights_created, insights_updated,
    //                 contradictions_flagged, gaps_created, confidence_decayed, validation_rejected
  }
}
```
> No new audit format — reuse `READ/inject`/`READ/recall` and add only `CRON/synthesis`. Flag-only terminology (`contradictions_flagged`), not "resolved".

### Summary: Complete Property Reference

| Property | Type | Origin | Updated By | Purpose |
|----------|------|--------|-----------|---------|
| memoryId | UUID | Write pipeline | - | Identity |
| primaryType | enum | Write pipeline | - | Classification |
| kind | enum? | Write pipeline / Synthesis | Synthesis sweep | Semantic kind |
| confidence | 0-1 | Write pipeline / Synthesis | Synthesis sweep (decay) | Truth/validity |
| freshness | 0-1 | Synthesis | Synthesis sweep | Recency/validation |
| basis | enum | Write pipeline / Synthesis | - | Creation method |
| derivedFrom | string[] | Synthesis | - | Traceability |
| costIfIgnored | string | Write pipeline | - | Priority signal |
| lastRevisedAt | RFC3339 | Write pipeline / Synthesis | Synthesis sweep | Freshness anchor |
| lastAccessedAt | RFC3339 | Read pipeline | - | Access frequency |
| stalenessFlag | enum? | Synthesis | Synthesis sweep | Staleness marker |
| hasContradiction | boolean | Synthesis | Synthesis sweep | Conflict flag |
| contradictions | array | Synthesis | Synthesis sweep | Conflict details |

---

## What's Next

Once this schema is approved:
1. **Phase 1:** Design detailed implementation plan
2. **Phase 2:** Implementation roadmap with milestones
3. **Phase 3:** API specifications for synthesis + read pipelines
4. **Phase 4:** Dashboard UI specifications for new components
5. **Phase 5:** Rollout & monitoring strategy

