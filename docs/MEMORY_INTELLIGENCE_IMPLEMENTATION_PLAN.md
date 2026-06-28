# Memory Intelligence Layer — Implementation Plan

**Date:** June 27, 2026  
**Project:** UniMind  
**Stakeholder:** Product & Engineering

---

## Overview

This document outlines the phased implementation of the Memory Intelligence Layer, moving UniMind from passive storage+retrieval to active synthesis, intelligent injection, and gap-driven learning.

**Total Scope:** 4 phases over ~8-12 weeks  
**Complexity:** Medium-High (new cron job, read pipeline redesign, dashboard features)  
**Risk Level:** Low (additive features, backward compatible)

---

## Phase 1: Foundation (Weeks 1-2)

### Goals
- Extend Memory data model with confidence, freshness, and synthesis metadata
- Add gap and contradiction tracking structures
- Set up audit logging for synthesis operations

### Components to Build

#### 1.1 MemoryNode Schema Extension

Update `src/db/schema.ts` MemoryNode interface with 9 new properties:

**New properties to add:**
```
freshness: number                    // 0-1, time-decay based
basis: string                        // "direct_statement"|"pattern_analysis"|"entailment"|"conflict_resolution"
derivedFrom?: string[]               // source memory IDs (for synthetic)
costIfIgnored?: string               // "4h debugging", "1 week refactor", etc
lastRevisedAt?: string               // when content/meaning last changed
stalenessFlag?: string               // "consider_refresh"|"needs_update"|null
kind?: string                        // "synthetic"|"insight"|"heuristic"|"preference"|"antipattern"|"knowledge_gap"
hasContradiction?: boolean           // does this contradict another?
contradictions?: Array<{...}>        // array of contradiction records
```

**Index creation (in bootstrap.ts):**
- Index on `kind` (for filtering by memory kind)
- Index on `basis` (for filtering by creation method)
- Index on `lastRevisedAt` (for freshness queries)
- Composite index on `(primaryType, kind)` (for validating constraints)

#### 1.2 Edge Type Additions (HelixDB Graph)

Create new edge type constants in `src/db/schema.ts`:
```
SYNTHESIZED_FROM   // Memory → Memory (synthesis-generated)
CONTRADICTS        // Memory → Memory (bidirectional conflict)
RESOLVES_CONTRADICTION  // Memory → Memory — defined but NOT used in v1 (flag-only contradictions; reserved for future "take sides" mode)
ADDRESSES_GAP      // Memory → Gap
RELATED_TO_THEME   // Memory → Memory (theme clustering)
```

#### 1.3 Gap & Contradiction Storage (NO new tables — decided during grilling)

**Gaps are NOT a separate table.** A gap is a regular Memory node with `primaryType: "CONTEXTUAL"` + `kind: "knowledge_gap"` (per `MEMORY_INTELLIGENCE_SCHEMA.md` Part 4). Reasons:
- Rides inside the existing Memory fetch on the dashboard graph (no new node label, no per-label budget dilution, shows in the RHS detail panel generically).
- Gets the 30-day TTL hard-delete **for free** from the existing hourly `expire-contextual` sweep — no new cleanup job.
- Reuses the existing write/persist/recall machinery; no new `primaryType` (which would force changes across conflict, decay, ranking, retrieve, and validation).
- **Note:** the gap node and the memory that *fills* it are different nodes — the filling memory is a normal long-term SEMANTIC memory and is unaffected by the gap's expiry.

Gap-specific data is encoded on the existing MemoryNode (see schema Part 4): `tags` carry `gap:<topic>`, `priority:<level>`, `status:<state>`; `suggestedPrompts` in content/tags; related memories via `RELATED_TO_THEME` / `ADDRESSES_GAP` edges.

**Contradiction metadata** (stored as Memory node property):
- Stored in `contradictions` JSON array + `hasContradiction` flag
- No separate table needed (embedded in memory)

#### 1.4 Data Migration — LAZY READ-TIME DEFAULTS, no eager backfill (decided during grilling)

**Do NOT run a bulk backfill over existing memories.** HelixDB is schema-on-write, so missing properties are simply absent (read as undefined) — harmless. Instead, the read/projection layer coalesces missing fields to neutral defaults:
```
freshness    → freshnessFactor neutral 1.0 (NO penalty, NOT "max freshness") — see §3.3
basis        → "direct_statement"   (display default; never persisted onto old nodes)
derivedFrom  → []
costIfIgnored→ null
lastRevisedAt→ falls back to createdAt for any freshness calc
stalenessFlag→ null
kind         → null (raw memory)
hasContradiction → false
contradictions   → []
```

**Why lazy, not eager:**
- No risky bulk write over the whole store.
- The augmented ranking must tolerate old nodes lacking confidence/freshness anyway, so coalescing is needed regardless.
- We never **persist** a guessed `basis` onto old inferred memories (it stays a display default we can improve later).
- New writes set all fields going forward; old memories acquire real values naturally as synthesis re-confirms them or they're superseded.

**Result:** the feature ships with ZERO behavior change on day 0; intelligence "fades in" as new data and nightly sweeps accrue. Old and new memories coexist; old still-true memories keep ranking on their merits and are only demoted if they genuinely go stale.

#### 1.5 Schema Validation Rules

A single `validateMemoryNode()` runs in the write path (both `persistMemory` and the synthesis persist) — there is no validation layer today. **On failure: skip that one memory + write an audit-log rejection. Do NOT throw/abort** — matches the codebase's "partial success OK" synthesis philosophy and fire-and-forget audit, so one bad synthetic memory can't crash the whole 11 AM sweep. Validation enforces only the integrity-protecting rules below:

**Kind-to-PrimaryType validation:**
```
IF kind = "synthetic" THEN primaryType IN ("SEMANTIC", "PROCEDURAL")
IF kind = "knowledge_gap" THEN primaryType = "CONTEXTUAL"
IF primaryType IN ("EPISODIC", "GOAL") THEN kind MUST BE null
IF kind = "knowledge_gap" THEN expiresAt MUST BE set
IF kind = "synthetic" THEN derivedFrom array MUST NOT be empty
```

**Freshness calculation validation:**
```
IF lastRevisedAt not set THEN freshness calc uses createdAt as fallback
IF lastRevisedAt > now() THEN error (future timestamp)
Freshness MUST BE between 0.0 and 1.0
```

**Contradiction consistency validation:**
```
IF hasContradiction = true THEN contradictions array length >= 1
IF contradictions array has items THEN hasContradiction MUST BE true
FOR EACH contradiction record:
  - withMemoryId MUST reference valid memory
  - confidence MUST BE 0.0-1.0
  - resolution MUST NOT be empty
```

**Freshness-Confidence independence validation:**
```
Freshness and confidence are independent scores
Can have: high confidence + low freshness (true but old)
Can have: low confidence + high freshness (recent but uncertain)
```

#### 1.6 Audit Schema
- **Reuse the existing `AuditInput`/`AuditRecord` shape** (`src/audit/types.ts`: `category`, `actor`, `status`, `summary`, `details`) — do NOT add new top-level fields. The SQLite audit table is unchanged.
- **Add ONE new `AuditCategory` value: `"CRON/synthesis"`** (`actor: "cron"`). Reads reuse the existing `READ/inject` / `READ/recall` categories.
- New intelligence signals go in the `details` JSON only:
  - Reads: `task_type`, `criticality`, `token_budget`, `injected_count`, `annotations{}`
  - Synthesis: `patterns_found`, `insights_created`, `insights_updated`, `contradictions_flagged`, `gaps_created`, `confidence_decayed`, `validation_rejected`
- One row per synthesis sweep (matches the existing "one row per logical cron operation" convention). `confidence_decayed` is DISTINCT from the existing `CRON/decay` (weight decay at 04:00).

#### 1.7 API Contracts
- Define intake/output shapes for:
  - Synthesis sweep function (input: past N days, output: changes made → audit `details`)
  - Gap detection function (input: memory cluster, output: gaps) — narrow trigger, capped
  - Contradiction **detector** (flag-only): input two memories → output `{ conflicts: bool, note: string }`. NO winner, NO confidence change (it detects + describes; it does not "resolve")
  - Task inference: folded into the existing read planner (`planner.ts`) output, NOT a standalone function — adds task_type + criticality to that one LLM call
  - `validateMemoryNode()` (input: full node, output: valid/invalid + reasons) — used in write path; skip-and-audit on failure

---

## Phase 2: Synthesis Engine (Weeks 3-5)

### Goals
- Build synthesizeSweep cron job that runs daily at 11 AM
- Implement pattern detection and contradiction resolution
- Implement gap detection logic

> **Scope note:** Entailment & Inference is **deferred** to `FUTURE_ENHANCEMENT.md` (FE-1). v1 synthesis = pattern detection + contradiction + gap, plus confidence decay.

### Components to Build

#### 2.1 Pattern Detection Module
**What it does:**
- Clusters memories by theme via **hybrid clustering**: deterministic greedy threshold clustering over existing memory embeddings (reuse the vector search in `src/db/retrieve.ts`) to form candidate groups, then **one LLM call per qualifying cluster** to write the synthetic statement + confidence. (Matches the codebase's "deterministic gather, single LLM synthesize" philosophy.)
- Detects recurring patterns using the threshold: **5+ distinct memories spanning ≥3 distinct sessions** (`sourceSessionId`). This ensures a "pattern" recurs *across conversations*, not just repeated once in a chatty session.
- Creates SEMANTIC "synthetic" memories for patterns.

**Inputs:**
- All EPISODIC and GOAL memories from past N days (configurable, default 30)
- Pre-computed embeddings for each memory

**Outputs:**
- List of new SEMANTIC synthetic memories to insert
- Updated confidence scores for existing semantics

**Idempotency (critical — daily sweep over a rolling window):**
- Before persisting a new synthetic memory, vector-search existing `kind=synthetic` memories of the same `primaryType`. If a match clears the existing `conflict.ts` HIGH threshold (0.9):
  - **UPDATE in place** — refresh `lastRevisedAt`, union `derivedFrom` with new source IDs, re-assert confidence from current evidence count.
  - Only **create new** when no match exists.
- This makes the sweep convergent (re-running on the same data is a no-op except timestamp refresh) and reuses existing conflict machinery.
- **Evidence aging out:** when source episodes scroll out of the rolling window, the synthetic memory **persists untouched** and decays confidence naturally via the idle sweep (it is now a learned semantic fact, independent of the raw episodes).

**Confidence tiers:**
- 5+ memories / ≥3 sessions → 0.85 (basis: pattern_analysis)
- 3-4 memories / ≥3 sessions → 0.70 (basis: pattern_analysis)

**Success Criteria:**
- Correctly groups related episodes by theme
- Identifies genuine patterns (not noise)
- Confidence scoring aligns with decision rules
- Re-running the sweep does not create duplicate synthetic memories

#### 2.2 Contradiction Detection Module (FLAG ONLY — decided during grilling)
**What it does:**
- Finds genuine **stance reversals** (user changed their mind), NOT coexisting nuance.
- **Flags both memories and records a neutral reconciliation note. Does NOT pick a winner and does NOT change any confidence.** Keeps the codebase's existing "keep both" behavior intact; purely additive.

**Detection Logic:**
- Semantic similarity of memory text embeddings + keyword/topic overlap (same entity/topic)
- **Mutually exclusive stance** — new statement cannot be true at the same time as the old (a changed decision/direction), not a caveat or trade-off
- Same memory class only (don't flag episodic vs semantic)
- LLM judgment call, **biased toward NOT flagging** when both could hold
- ✅ Flag: "prefers monorepos" → "decided microservices for all future projects"
- ❌ Don't flag: "prefers monorepos" + "monorepos are hard to navigate" (both can be true)

**On flag (no winner picked):**
- Set `hasContradiction: true` + append `contradictions[]` note on both memories
- Draw a neutral `CONTRADICTS` edge with the reconciliation note
- `RESOLVES_CONTRADICTION` / `has_alternative` edges are **NOT used in v1** (they imply taking sides)

**Inputs:**
- All memories (focus on SEMANTIC + PROCEDURAL), embeddings for comparison

**Outputs:**
- Both memories flagged with neutral contradiction metadata + `CONTRADICTS` edge

**Success Criteria:**
- Low false-positive rate — nuance/trade-offs are NOT flagged, only real reversals
- Both versions preserved (not deleted), neither re-ranked
- Reconciliation note is understandable to the reader

#### 2.3 Gap Detection Module (NARROW trigger — decided during grilling)
**What it does:**
- Identifies topics the user **keeps returning to in their own memories** but has never taken a stance on, and creates CONTEXTUAL gap nodes.

**Trigger (bounded + conservative):**
- ✅ Fire ONLY when a topic **recurs across several of the user's own memories/sessions** yet has **no SEMANTIC opinion/preference/stance recorded** for it. Evidence must come from *within* existing memories — never from "topics that could theoretically relate to the user's expertise."
- ❌ Do NOT fire on "expert in X but nothing about related topic Y" — that is unbounded and manufactures junk (e.g. "backend expert, no memories on quantum computing").
- When unsure, **do not create the gap** (bias to fewer gaps).

**Anti-noise guards:**
- **Cap** open gaps (top N by priority) so injection/dashboard never floods.
- **No-nag:** stop re-surfacing a gap after it's been shown a couple of times without being filled; let the 30-day TTL expire it quietly.

**Priority Assignment:**
- critical: Core to user's main domain
- high: Frequently related to other high-value memories
- medium: Occasional relevance
- low: Peripheral to main interests

**Inputs:**
- Memory graph (theme clusters) — user's own memories only

**Outputs:**
- New CONTEXTUAL gap nodes (capped), priority levels, suggested prompt questions

**Success Criteria:**
- Gaps reflect topics the user actually keeps touching (no out-of-nowhere topics)
- Low noise — conservative firing, capped count, no nagging
- Suggested prompts are natural/useful

#### 2.4 Synthesis Scheduler & Orchestration
**What it does:**
- Registers cron job to run daily at 11 AM
- Calls the modules in sequence: pattern detection → contradiction → gap → confidence decay
- Logs results to audit table
- Handles failures gracefully (partial success is OK)

**Failure Handling:**
- If pattern detection fails, continue to contradiction detection
- If contradiction detection fails, continue to gaps
- Confidence decay runs last; it skips soft-deleted + PROCEDURAL-evergreen memories and keys idle off `lastAccessedAt`
- Log warnings for partial failures
- Email alert if full synthesis fails

> **Ordering note:** Synthesis runs at 11:00, *after* the existing 04:00 forget sweep, so confidence decay only ever sees survivors (never tombstoned rows).

**Success Criteria:**
- Runs daily on schedule
- Completes in < 5 minutes
- All audit entries logged
- No data corruption on failure

---

## Phase 3: Selective Injection Read Pipeline (Weeks 6-8)

### Goals
- Redesign recall() function to support task inference and context-aware filtering
- Implement confidence + freshness filtering
- Implement task-aware memory selection
- Integrate gap surfacing

### Components to Build

#### 3.1 Conversation Analysis & Task Inference
**What it does:**
- Infers task type (coding, learning, decision, debugging, design, exploration), criticality (low/medium/high), and the adaptive injection token budget.

**How (decided during grilling):**
- **Fold the task guess into the EXISTING read-path LLM call** (the `planner` in `src/read/planner.ts` that already extracts topics + entities on every read). Add task_type + criticality to that call's output schema.
  - Rationale: the read path already pays for exactly one LLM call. Piggybacking the task guess onto it means **no extra latency, no extra cost, and a real-language-understanding guess** — far better than keyword spotting at handling mixed-signal sentences (e.g. "why does my code break when I change the design?"). No second classifier brain.
- **The guess is a nudge, not a gate.** It *adjusts* type weights in ranking (§3.4). On low confidence, **fall back to current type-priority ranking unchanged** — nothing breaks if the guess is wrong.

**Inputs:**
- The prompt + recent context already passed to the planner.

**Outputs:**
- task_type (string), criticality (low|medium|high), adaptive token budget (~300/~500/~800) with ~10-memory backstop + min 1 (see §3.4/§3.3 budget model)

**Success Criteria:**
- _(Dropped the unmeasurable ">85% accuracy" target — there is no ground-truth label set to measure it against.)_
- When confident, the guess improves which memory kinds surface; when unsure, recall behaves exactly as today (graceful fallback, no regression).
- No added latency on the read path (reuses the single existing LLM call).
- Budget adapts sensibly (exploration = lower, decision = higher).

#### 3.2 Candidate Retrieval with Hybrid Search
**What it does:**
- Retrieves memories by semantic + keyword relevance
- Returns top 30 candidates (before filtering)

**Search Components:**
- Vector similarity (embedding distance)
- BM25 full-text search
- Hybrid ranking (weighted combination)
- Handles memory type weighting

**Inputs:**
- Current context embedding
- Inferred task type (used for type weighting)
- Top-K to retrieve (30)

**Outputs:**
- List of memory candidates with raw relevance scores

**Success Criteria:**
- Covers 95%+ of truly relevant memories in top 30
- Fast enough for real-time injection (< 100ms)

#### 3.3 Filtering & Ranking Pipeline
**What it does:**
- Applies filters in sequence
- Removes ineligible memories
- Ranks remainder by weighted score
- Selects final subset

**Filter Chain:**
1. Expiration filter (remove expired CONTEXTUAL)
2. Deletion filter (skip soft-deleted)
3. Contradiction filter — DO NOT remove (flag-only, §Part 5); contradicted memories stay, just annotated
4. Confidence filter (high-criticality tasks require > 0.65)
5. Freshness — applied as a penalty factor in ranking (below), not a separate boost

**Final Ranking Score — AUGMENT the existing formula, do NOT replace it (decided during grilling):**
```
score = sim × recency × weight × priority × confidenceFactor × freshnessFactor
```
- Keeps today's `sim × recency × weight × priority` from `src/read/rank.ts` (preserves reinforcement `weight` + `type_priority`). Do NOT switch to the additive `relevance×0.5 + confidence×0.3 + freshness×0.2` (that silently drops `weight` and `priority`).
- **`confidenceFactor` and `freshnessFactor` are PENALTY-ONLY, range `(0, 1]`:** `1.0` = neutral (no change); below `1.0` = demote weak/stale. They can ONLY pull a score down, never inflate it above the current ranking.
- **Missing `freshness` (old/un-migrated memories) → freshnessFactor = neutral 1.0** (NOT "max freshness"). So old memories rank exactly as today until synthesis computes a real freshness; only genuinely stale ones get demoted. `confidence` exists on all memories already, so no default needed there.
- Requires projecting `confidence` + `freshness` into `RecallRow` (`src/db/retrieve.ts`) — additive.

**Inputs:**
- Candidate memories
- Task type, criticality
- Current conversation context

**Outputs:**
- Ranked list of eligible memories
- Score for each

**Success Criteria:**
- Filtered memories are all relevant
- Top-ranked matches user intent
- No false positives (injecting wrong domain)

#### 3.4 Task-Aware Selection
**What it does:**
- Selects final memories based on task type
- Prioritizes memory kinds for each task
- Cuts to the **adaptive token budget** (~300/~500/~800 by task/criticality) with a ~10-memory backstop and guaranteed min 1 — extends `rankMemories(tokenBudget)` in `src/read/rank.ts` (NOT a raw count cap; see §3.3 rationale)

**Task-Kind Mapping:**
- coding → PROCEDURAL + antipatterns (warnings)
- learning → EPISODIC examples + PROCEDURAL step-by-step
- decision → SEMANTIC insights + contradictions (trade-offs)
- debugging → PROCEDURAL + costIfIgnored estimates
- design → SEMANTIC insights + gaps (missing dimensions)
- exploration → gaps + novel connections + low-confidence insights

**Selection Algorithm:**
- Top candidates by task preference
- Include at least 1 gap if priority=high
- Include contradictions if detected
- Fill until the adaptive token budget is reached (or ~10-memory backstop hit), guarantee min 1

**Outputs:**
- Final list (size varies with token budget; ~1–10 memories)
- Ordered by score

**Success Criteria:**
- Selected memories match task type effectively
- LLM finds them useful (inferred from follow-up behavior)
- Budget respected

#### 3.5 Injection Formatter (split by channel — decided during grilling)

Two formats for two delivery paths (see schema §3.2):

**(a) Always-on header (hook) — COMPACT plain-text + minimal annotations.** Extend the existing `src/read/header.ts` `buildHeader()` (do NOT replace it with JSON — this is injected every turn). A clean memory stays one line; annotations appear ONLY when they change how the assistant should treat the memory:
```
Relevant memories:
- User prefers async patterns in Go
- User preferred monorepos  ⚠ later chose microservices for all future projects — weigh by recency
- User uses Kubernetes on AWS for metering  [low confidence · unconfirmed 90d]
Knowledge gaps:
- No stated approach to monitoring/observability — consider asking
```
- Contradiction note: shown when `hasContradiction = true` (the `contradictions[]` note).
- Caution tag `[low confidence · unconfirmed Nd]`: shown when `confidence` low OR `stalenessFlag` set.
- `Knowledge gaps:` group: 1–2 high-priority gaps (capped, no-nag).
- **NOT in the header:** memoryId, basis, derivedFrom count, raw freshness, costIfIgnored, lastValidated, taskRelevance (→ dashboard/audit/recall tool only).

**(b) On-demand `recall()` MCP tool — RICH structured output.** Only here (explicit, not every-turn) return the full per-memory object:
```
[
  { memoryId, type, kind, text,
    metadata: { confidence, freshness, basis, derivedFrom, costIfIgnored, lastValidated },
    contradictions: [{ text, resolution, confidence }],
    relatedGaps: [{ topic, priority }] }
]
```

**Inputs:** Selected memories + task type

**Outputs:** (a) compact annotated header text for the hook; (b) structured objects for the `recall()` tool

**Success Criteria:**
- Header stays cheap — a clean memory is one line; annotations are the exception not the rule
- No raw bookkeeping fields leak into the every-turn header
- `recall()` tool preserves full metadata for deliberate deep dives

#### 3.6 Read Pipeline Integration
**What it does:**
- Wires task inference → retrieval → filtering → selection → formatting into single recall() function
- Replaces current naive recall

**Inputs:**
- Current context (embeddings, turns)

**Outputs:**
- Hook path: compact annotated header text (§3.5a)
- `recall()` tool path: rich structured objects (§3.5b)

**Backward Compatibility:**
- Old read code continues to work
- New selective injection is additive
- Can A/B test old vs new

**Success Criteria:**
- All components work together
- Sub-100ms latency
- No regressions in retrieval quality

---

## Phase 4: Dashboard & Observability (Weeks 9-10)

### Goals
- Update dashboard to visualize insights, contradictions, gaps as first-class nodes
- Add memory detail panel with all new metadata
- Build synthesis audit log viewer
- Add gap lifecycle tracking

### Components to Build

#### 4.1 Graph Visualization Updates

> **Reminder:** insight / gap / contradiction are NOT separate node labels — they are Memory nodes distinguished by `kind`/properties (Part 8). So styling keys off **`primaryType` + properties**, not label.

**Node Styling (combined scheme — decided during grilling):**
- **Base color = `primaryType`** (EPISODIC / SEMANTIC / PROCEDURAL / CONTEXTUAL / GOAL). `primaryType` is mandatory on every memory, so EVERY node always gets a color — old memories included (no missing-value problem; this is why we color by primaryType, not by the optional `kind`).
  - Implementation: today `nodeColor(label)` returns one color for all Memory nodes. Change so **Memory-label nodes sub-color by `primaryType`**; Entity/Category/Session keep their existing label colors.
- **Additive overlay markers** (layered on top of the base color, ONLY when the property is present — absent marker = ordinary memory, so old/un-flagged memories just render plain):
  - ⭐ gold badge/ring = Insight → `kind: "synthetic"`
  - ▢ greyed/dashed = Gap → `kind: "knowledge_gap"`
  - 🔴 red outline = Contradiction → `hasContradiction: true`

**Edge Styling (color by edge type):**
- Add the new edges to the dashboard's fetched `EDGE_LABELS` (`src/lib/helix.ts`): `SYNTHESIZED_FROM`, `CONTRADICTS`, `ADDRESSES_GAP`, `RELATED_TO_THEME`.
- Refactor `linkColor` to color by `link.type`:
  - SYNTHESIZED_FROM / derived: thin gray "derived from"
  - CONTRADICTS: red dashed + reconciliation note on hover (flag-only; no winner shown)
  - ADDRESSES_GAP: green
  - RELATED_TO_THEME: faint cluster line

**Legend / header (updated — decided during grilling):**
- Break the single "Memory (N)" entry into a per-`primaryType` breakdown with color bubble + count; keep Entity/Category/Session as-is; keep the `nodes · edges` totals line.
- Add a **Markers** sub-key explaining the overlays (Insight / Gap / Contradiction) with counts.
```
Memories
  ● EPISODIC    (312)
  ● SEMANTIC    (240)
  ● PROCEDURAL  (98)
  ● CONTEXTUAL  (41)
  ● GOAL        (19)
● Entity    (243)
● Category  (12)
● Session   (88)

Markers
  ⭐ Insight (synthetic)   (37)
  ▢ Gap (knowledge_gap)   (4)
  🔴 Contradiction         (6)

1053 nodes · 1492 edges
```

**Inputs:** HelixDB graph (nodes + edges, including new edge labels)

**Outputs:** Interactive force-directed graph with primaryType colors + property markers

**Success Criteria:**
- Every memory is colored by primaryType (old memories without `kind` still render correctly)
- Insight/gap/contradiction visible via overlay markers; new edges colored by type
- Legend shows primaryType breakdown + markers sub-key + totals
- Clicking nodes triggers detail panel

#### 4.2 Memory Detail Panel — RICH panel (Option B, decided during grilling)

The current `NodePropertiesPanel.tsx` is already **generic** (renders all node props as key–value, vectors separated) — that alone satisfies the "show all properties on click" goal. Option B builds a **richer** panel on top of it:

**Panel Contents:**
- Memory text
- primaryType + kind + confidence + freshness (with visual **gauges**)
- Basis (how created?)
- If `kind: synthetic`: source memories (**clickable** → navigate via `derivedFrom` / SYNTHESIZED_FROM)
- If `hasContradiction`: the conflicting memory + reconciliation note (flag-only — show both neutrally, NO "winner/alternative" framing)
- If `kind: knowledge_gap`: status + suggested prompts + related memories
- Audit trail (last used, last revised, injection count)

**Graceful with lazy defaults:** old memories missing the new fields simply omit those rows / show neutral defaults — the panel must not error on absent props.

**Inputs:** Memory node ID

**Outputs:** Rich formatted detail panel

**Success Criteria:**
- Gauges for confidence/freshness render; missing values degrade gracefully
- Related/source nodes are clickable (navigation)
- Contradiction shown neutrally (no winner), gap shows prompts + related memories

#### 4.3 Synthesis Audit Log Viewer
**What it does:**
- New dashboard page showing synthesis sweep results
- Filterable by date, operation, result

**Display:**
- Daily runs in chronological order
- For each run: insights created/updated, contradictions flagged, gaps found, confidence decayed, validation rejected
- Links to created insight nodes
- Status (success, partial, failed)

**Inputs:**
- Audit log table

**Outputs:**
- Formatted table + summary stats

**Success Criteria:**
- All synthesis runs visible
- Easy to understand what changed each day
- Can drill into details

#### 4.4 Gap Lifecycle Viewer
**What it does:**
- Dashboard widget showing gap status
- Allows manual close/reopen

**Display:**
- All open gaps
- Priority + age
- Suggested prompts
- Related memories
- Manual close button

**Inputs:**
- CONTEXTUAL memories where `kind = "knowledge_gap"` (filtered from the Memory store; no separate table)

**Outputs:**
- Gap list + controls

**Success Criteria:**
- User can see all gaps
- Can understand why each gap matters
- Manual actions reflected in system

#### 4.5 Contradiction Visualization (flag-only — neutral, no winner)
**What it does:**
- Special view listing flagged contradictions, shown **neutrally** (no authoritative "winner")

**Display:**
- List of detected contradictions
- The two conflicting memories shown side-by-side as **equal peers** (NOT "winner vs alternative")
- Reconciliation note (the neutral `contradictions[].resolution` text)
- Both memories' confidence shown for context (neither was re-ranked)

**Inputs:**
- Memories with `hasContradiction = true` + their `contradictions[]` arrays and `CONTRADICTS` edges (no separate table)

**Outputs:**
- Formatted contradiction viewer

**Success Criteria:**
- User understands each contradiction and the reconciliation note
- Presentation is neutral — no implication that one memory "won"
- User can manually correct/dismiss a wrongly-flagged contradiction

---

## Phase 5: Optimization & Hardening (Weeks 11-12)

### Goals
- Performance tuning (synthesis < 5min, recall < 100ms)
- Monitoring & alerting setup
- Error recovery procedures
- Documentation

### Components to Build

#### 5.1 Performance Optimization
**Synthesis Sweep:**
- Index memory embeddings for fast clustering
- Batch contradiction detection (don't compare all pairs)
- Cache theme clusters from previous day
- Profile and optimize bottlenecks

**Read Pipeline:**
- Cache task inference model (if using ML)
- Pre-compute relevance scores incrementally
- Optimize vector search indices

#### 5.2 Monitoring & Alerts
**Synthesis Monitoring** (reads from `CRON/synthesis` audit rows):
- Alert if synthesis doesn't complete by 11:30 AM
- Alert if contradiction detection **flags** > 50 in one run (possible over-flagging bug — recall flag-only fires on genuine reversals, so a spike is suspicious)
- Alert if `validation_rejected` spikes (synthesis producing malformed memories)
- Daily report: # insights created/updated, # contradictions flagged, # gaps, # confidence decayed
- Trend analysis: Is synthesis producing less useful insights over time?

**Read Pipeline Monitoring:**
- Latency tracking (p50, p95, p99) — must stay flat since task inference rides the existing single read LLM call (no new call)
- Hit rate tracking (what % of injected memories used by LLM?)
- Task inference: spot-check sampling only (no hard accuracy SLA — there's no ground-truth label set; the guess is a best-effort nudge with graceful fallback)
- Token-budget utilization (distribution of adaptive 300/500/800 budgets; how often the ~10-memory backstop trips)

**Dashboard:**
- New Monitoring section showing synthesis health
- Read pipeline performance metrics
- Gap closure rate trends

#### 5.3 Error Recovery
**Synthesis Failure:**
- Automatic retry with exponential backoff
- Notify ops if 3 retries fail
- Ensure partial results don't corrupt data
- Rollback mechanism if synthesis introduces bad data

**Read Pipeline Failure:**
- Fallback to old naive recall if new pipeline fails
- Log errors for debugging
- Graceful degradation (inject fewer memories if filtering is broken)

#### 5.4 Documentation
**For Engineers:**
- Synthesis sweep internals (how each module works)
- Read pipeline architecture (data flow)
- Database schema changes
- Deployment playbook

**For Users (Dashboard Help):**
- What are insights? How are they created?
- How are contradictions flagged? (we surface disagreements neutrally — we don't pick a winner)
- What do gaps mean?
- How to use the new features?

---

## Risk & Mitigation

### Risk 1: Synthesis Cron Introduces Bad Data
**Mitigation:**
- Extensive unit tests for each module
- Gradual rollout (run synthesis in shadow mode, don't use results yet)
- Manual validation of first week's results
- Rollback plan if needed

### Risk 2: Read Pipeline Performance Regresses
**Mitigation:**
- Latency SLA: < 100ms for recall
- A/B test old vs new in parallel
- Optimize before going live
- Fallback to naive recall

### Risk 3: Task Inference Gets It Wrong
**Mitigation:**
- Manual validation of inferred tasks (sample 10% of sessions)
- Graceful fallback if inference uncertain
- Allow explicit task hints from user ("this is a design decision")
- Improve inference model over time

### Risk 4: Gap Detection Creates Noise
**Mitigation:**
- Conservative initial thresholds
- Manual review of first 100 gaps
- Require multiple signals for gap creation
- Allow users to dismiss gaps

---

## Dependencies & Prerequisites

### External Systems
- HelixDB (already deployed)
- MinIO (already deployed)
- iii Engine (already deployed)
- Existing audit log system

### Assumptions
- Memory embeddings already computed for all stored memories
- Task inference can be rule-based (no ML required initially)
- Dashboard already has graph visualization infrastructure

### Not in Scope (Future Phases)
- ML-based task inference (using a classifier model)
- Entailment & inference, basic and advanced (deferred — see `FUTURE_ENHANCEMENT.md` FE-1)
- User feedback loop (training task inference from corrections)
- Memory refresh recommendations (proactively ask to re-validate old memories)

---

## Success Criteria by Phase

### Phase 1: Foundation
- ✓ Database schema extended without data loss
- ✓ All 9 new properties added to MemoryNode interface
- ✓ 5 new edge types created in HelixDB graph
- ✓ Gaps stored as CONTEXTUAL memories (`kind="knowledge_gap"`) — no separate table
- ✓ Lazy read-time defaults work — old memories (lacking new fields) recall correctly and rank identically to pre-feature behavior (no eager backfill)
- ✓ Schema validation rules implemented and tested
- ✓ Audit logging functional for all operations
- ✓ API contracts defined and reviewed
- ✓ Zero data corruption, full rollback capability

### Phase 2: Synthesis
- ✓ synthesizeSweep cron runs daily
- ✓ Creates >= 5 insights per week
- ✓ Detects contradictions (< 5% false positive rate)
- ✓ Identifies useful gaps (user finds them relevant)

### Phase 3: Read Pipeline
- ✓ Task inference accuracy > 85%
- ✓ Recall latency < 100ms
- ✓ Injected memories are used by LLM (implicit from conversation)
- ✓ No regressions in retrieval quality

### Phase 4: Dashboard
- ✓ All new node types visible and interactive
- ✓ Detail panel shows all metadata
- ✓ Synthesis audit log accessible
- ✓ Gap viewer functional

### Phase 5: Optimization
- ✓ Synthesis completes in < 5 minutes
- ✓ Monitoring dashboards operational
- ✓ All critical documentation written
- ✓ Error recovery tested

---

## Timeline Summary

```
Week 1-2:  Foundation (schema, migrations, audit)
Week 3-5:  Synthesis Engine (pattern, contradiction, gap, decay)
Week 6-8:  Read Pipeline (task inference, filtering, selection, formatting)
Week 9-10: Dashboard (graph viz, detail panel, audit log)
Week 11-12: Optimization (performance, monitoring, documentation)

Total: ~12 weeks
Expected Start: Early July 2026
Expected Go-Live: Late September 2026 (after hardening phase)
```

---

## Rollout Strategy

### Phase 1: Development
- Build all components in feature branches
- Write comprehensive unit tests
- Internal testing only

### Phase 2: Beta (Internal)
- Deploy to staging environment
- Run synthesis, read pipeline in shadow mode
- Validate results manually
- Internal team uses new features

### Phase 3: Canary (1% Production)
- Deploy to 1% of production traffic
- Monitor metrics closely
- Maintain quick rollback path
- Fix issues as found

### Phase 4: Ramp (10% → 50% → 100%)
- Gradually increase traffic
- Monitor metrics at each step
- Adjust thresholds based on observations
- Full rollout when confident

### Phase 5: Stabilization
- Monitor in production for 2 weeks
- Fix any edge cases
- Optimize based on real-world usage
- Document learnings

---

## Budget & Resources

### Engineering Effort
- **Phase 1:** 40 hours (schema + migrations)
- **Phase 2:** 80 hours (synthesis engine)
- **Phase 3:** 100 hours (read pipeline redesign)
- **Phase 4:** 60 hours (dashboard updates)
- **Phase 5:** 40 hours (optimization + docs)

**Total:** ~320 engineering hours (~4 FTE-weeks for 2-person team)

### Infrastructure
- Additional HelixDB capacity for new tables/edges: minimal
- Synthesis cron job overhead: ~2 min/day CPU
- Dashboard performance impact: negligible

---

## Next Steps (After Approval)

1. Review schema document with stakeholders
2. Finalize Phase 1 scope & create detailed tickets
3. Begin Phase 1 development
4. Establish monitoring/alerting infrastructure
5. Set up beta testing framework

