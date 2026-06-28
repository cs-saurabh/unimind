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

---

## FE-2: Filesystem Event-Based Verification Trigger

**Status:** Deferred from the Memory Verifier Daemon v1 (cut on June 28, 2026 during plan grilling).
**Origin:** Discussed during Verifier Daemon design — `docs/verifier_daemon_design_notes.md`.

### What the feature is

A persistent host-side process that watches project directories on the filesystem for destructive events (file deletion, rename, move) and immediately triggers verification for memories that were backed by evidence from those files — without waiting for the next daily cron sweep.

- **Trigger:** `chokidar` (or equivalent) watcher detects a file delete/rename event in a known project directory.
- **Goal:** Catch "silent" user changes that bypass Claude Code hooks — e.g., the user manually removes MongoDB from a project's dependencies without going through Claude.
- **Output:** Targeted verification job enqueued in iii immediately, rather than waiting until the next daily sweep.

### Why it was deferred

1. **Missing prerequisite: file-to-memory index.** For a filesystem event to be useful, the system needs to know which memories were backed by evidence from which files. That index does not exist yet. Without it, a file deletion event has no way to identify which memories to re-verify.
2. **Infrastructure complexity.** A persistent watcher process needs to run continuously on the host, know which directories to watch (derived from entity/project graph), debounce noisy events (build artifacts, node_modules, git internals fire constantly), and send jobs to iii. This is a meaningful new daemon, not a small addition.
3. **Watcher noise.** File-level events are extremely high-volume in active projects. A naive watcher would flood the verification queue with false triggers on every `npm install`, git operation, or build run.
4. **Daily cron + contradiction trigger already covers the important cases.** The daily sweep with a hybrid eligibility filter (stale, never verified, contradiction present, high `costIfIgnored`) catches drift within 24 hours. The event-triggered path adds real-time detection but at significant cost.

### How to implement when picked up (notes for future you)

- **Prerequisite first: build the file-to-memory index.** When the verifier fetches evidence from a file (e.g., reads `package.json` to verify a dependency claim), it should record that file path against the memory ID in a new index (could be a simple HelixDB edge `Memory --VERIFIED_FROM_FILE--> <path>` or a separate SQLite table). Only once this index exists can file events be routed to the right memories.
- **Directory scope.** The watcher should only watch directories that correspond to known project entities in the graph — not the entire filesystem. Derive the watch list from Entity nodes with `entityType: "project"` and their known workspace paths.
- **Event debouncing.** Use a debounce window of at least 5 seconds. Batch all events within the window by project directory, then enqueue a single verification job per project rather than one per file.
- **Ignore patterns.** Exclude `node_modules/`, `.git/`, build output dirs, and hidden files by default. These are high-volume and almost never back a stored memory claim.
- **Integration point.** The watcher process should be a new host-side long-running script (similar to the MCP server's stdio process), not a container — it needs direct access to the host filesystem. It communicates with the iii worker via the same trigger mechanism as the existing hooks.
- **Whitelisted event types only.** Start with delete and rename events. File modification events are too frequent and too broad to be reliable triggers in v1 of this feature.

### Cross-references at time of deferral

- `docs/verifier_daemon_design_notes.md` — original design discussion where this was raised and deferred.
- The file-to-memory index (prerequisite) has no existing implementation — it must be designed and built before this feature is viable.

---

## FE-3: LLM-Based Claim Classifier (Add-on to Verifier Claim Classifier)

**Status:** Deferred from Memory Verifier Daemon v1 (cut on June 28, 2026 during plan grilling).
**Origin:** Discussed during Verifier Daemon design — `docs/verifier_daemon_design_notes.md`. This is an **add-on** to the v1 pattern-matching classifier, not a replacement.

### What the feature is

An LLM fallback layer added on top of the v1 rule-based claim classifier. When the pattern-matching rules cannot confidently classify a memory as verifiable or non-verifiable (the gray zone), a small LLM call steps in to make the call.

- **Input:** Memory content text that didn't match any known verifiable pattern (absolute path, filename + code claim, GitHub handle).
- **Process:** LLM is asked: "Does this memory make a concrete, checkable claim about something that physically exists — a file, a directory, a piece of code, a public identifier? Answer yes/no with the evidence type if yes."
- **Output:** `{ verifiable: boolean, evidenceType: "filesystem" | "git" | "web" | "shell" | null }`
- **Example gray-zone cases it would resolve:**
  - `"Saurabh Pawar is analyzing microAppsObj in the ARGUS project"` → LLM says: not verifiable (past transient action, no artifact)
  - `"node bubbles should not overlap in the graph canvas"` → LLM says: not verifiable (UI behavior, needs running app)
  - `"Nine new optional properties were added to MemoryNode"` → LLM says: verifiable, evidenceType: filesystem (check schema.ts)

### Why it was deferred

1. **"If in doubt, skip" is safer and cheaper in v1.** The cost of skipping a borderline memory is near-zero — it just stays unverified. The cost of trying to verify something the LLM incorrectly classified as verifiable is wasted compute + noisy false results.
2. **Pattern rules already capture the high-value cases.** Memories with absolute paths, file names, code symbols, and GitHub handles are the clearest and most common verifiable memories. An LLM layer adds marginal coverage over a long tail of ambiguous cases.
3. **KISS principle.** Adding an LLM call to the classifier means every eligible memory incurs an LLM cost before any evidence is even fetched. That's expensive to run 30 times a day at cron time. Better to validate the pattern-matching approach first and add LLM only when real gaps are observed in production.

### How to implement when picked up (notes for future you)

- **It is an add-on, not a rewrite.** The pattern-matching classifier runs first. The LLM layer only receives memories that the rules returned `"skip"` on — not the full eligible set.
- **Use a cheap model.** This is a binary classification call with a short prompt. `gpt-4o-mini` (the project's `HOT_MODEL`) is appropriate. The prompt should be under 200 tokens, and the response is a single JSON object.
- **Add a `classifierSource` field to the verification result** to distinguish rule-classified vs. LLM-classified memories in the audit log. This lets you measure how often the LLM fallback is firing and whether its verdicts are accurate.
- **Shadow mode first.** Before letting LLM-classified memories enter the full verification pipeline, log what the LLM would have decided for a few weeks and manually review precision. Only promote to active classification once you're confident the LLM isn't hallucinating verifiability on abstract memories.
- **Watch out for EPISODIC memories.** Past-action memories (`"Saurabh ran npm run build"`, `"Saurabh was analyzing X"`) consistently confuse the LLM because they describe real events — but those events leave no checkable persistent artifact. The prompt must explicitly instruct the LLM to ask "is there a file/directory/identifier I can check *right now* that reflects this claim?" not "did this event happen?"

### Cross-references at time of deferral

- `docs/verifier_daemon_design_notes.md` — original design notes where LLM placement in the pipeline was discussed.
- The v1 pattern-matching classifier lives in the Verifier Daemon implementation plan (to be written). This feature slots in *after* that classifier as a second-pass fallback.
