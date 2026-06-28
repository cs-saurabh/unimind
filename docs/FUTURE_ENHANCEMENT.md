# UniMind — Future Enhancements

**Purpose:** This document parks features that were intentionally **deferred** out of a current implementation plan. Each entry is written to be self-contained so that a future engineer (or agent) can pick it up cold — with enough context to understand *what* the feature is, *why* it was deferred, and *what to watch out for* when implementing it.

When you pick up an item from here:
1. Read its full entry below.
2. Re-validate it against the current codebase (schemas, pipelines, and thresholds drift over time).
3. Move it from this doc into the active implementation plan when scheduled.

---

## FE-1: Entailment & Inference (Synthesis Phase)

**Status:** Deferred from the Memory Intelligence Layer v1 (cut on June 27, 2026 during plan grilling).
**Origin:** Was originally "Phase 2: Entailment & Inference" in `MEMORY_INTELLIGENCE_SCHEMA.md` §2.1 and "Module 2.2" in `MEMORY_INTELLIGENCE_IMPLEMENTATION_PLAN.md`.

### What the feature is

A synthesis-sweep module that derives **new facts that the user never explicitly stated**, by applying logical rules over existing SEMANTIC and PROCEDURAL memories.

- **Input:** Stored SEMANTIC and PROCEDURAL memories + graph relationships (entity links).
- **Process:** Apply logical/inference rules to entail new facts from combinations of existing facts.
- **Output:** New SEMANTIC `kind: "synthetic"` memories with `basis: "entailment"`, confidence typically **0.72** (0.70–0.75 band).
- **Example:**
  - Stored: "User is security-conscious" + "User audits dependencies"
  - Entailed: "User likely values supply-chain security"
  - Output: SEMANTIC synthetic memory (confidence 0.72, basis: entailment)

### Why it was deferred

1. **It fabricates, not grounds.** Every *other* synthesis output (pattern detection, contradiction resolution, gap detection) is grounded in something the user actually said or in measurable graph structure. Entailment is the only module that *invents* facts. That makes it the single highest hallucination-risk component in the synthesis engine.
2. **Hard to validate.** The success criteria ("entailments are logically sound", "avoid spurious inferences") are effectively unfalsifiable without manual human review of every generated memory. There's no cheap automated signal that an entailment is correct.
3. **Low marginal value at high risk.** It produces the lowest-confidence memories (0.72), which the augmented read-ranking down-weights anyway, and which only barely clear the high-criticality confidence filter (`> 0.65`). The core "active synthesis" value promised by the schema's executive summary is already delivered by pattern detection + contradiction + gaps.
4. **KISS.** The owner (Saurabh) prefers simple, incrementally-trusted implementations. Entailment is better added *after* the rest of synthesis has earned trust in production.

### How to implement when picked up (notes for future you)

- **Suggested rollout: shadow mode first.** Generate entailed memories but store them flagged as non-injectable (e.g., excluded from the read pipeline) for a few weeks. Manually review precision before letting them reach a live session's context.
- **Schema is already forward-compatible.** The `basis` enum on `MemoryNode` retains the `"entailment"` value (kept intentionally so no schema migration is needed when this is picked up). See `MEMORY_INTELLIGENCE_SCHEMA.md` §1.3 / §6.1.
- **Reuse the synthesis idempotency rule.** Like pattern-detection synthetics, entailed memories must **update-in-place on re-derivation** (vector-match existing `kind=synthetic` memories above the `conflict.ts` HIGH threshold of 0.9; refresh `lastRevisedAt` + union `derivedFrom` instead of creating duplicates). Otherwise the daily sweep will pile up duplicate entailments.
- **Confidence decay applies normally.** Entailed memories follow the same idle-based confidence decay (`lastAccessedAt` anchor) as all other synthetic memories — they persist and decay naturally rather than being actively retired.
- **Inference rule source is the open design question.** Decide between (a) a small hand-curated rule set (deterministic, safe, limited coverage) vs (b) an LLM-driven "what does this combination imply?" call (broad coverage, higher hallucination risk). Given why it was deferred, lean toward (a) or a tightly-constrained (b) with shadow-mode validation.
- **The plan originally listed "Advanced entailment (complex logical rules)" under "Not in Scope"** — that note referred to a *more sophisticated* version. This deferral now covers entailment **entirely** for v1, basic and advanced alike.

### Cross-references at time of deferral

- `MEMORY_INTELLIGENCE_SCHEMA.md` — synthesis sweep phases renumbered after removal (Pattern → Contradiction → Gap → Confidence Decay).
- `MEMORY_INTELLIGENCE_IMPLEMENTATION_PLAN.md` — Phase 2 synthesis modules reduced from 4 generative modules to 3 (pattern, contradiction, gap) + decay.
