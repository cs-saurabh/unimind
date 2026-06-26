# Unimind Architecture

> A long-term memory system for Claude Code. As you work, hooks capture conversational
> events; an asynchronous pipeline extracts durable facts, classifies them, resolves the
> entities they mention, and stores them in HelixDB. On future prompts a fast synchronous
> path retrieves the relevant memories and injects them back into Claude's context — so
> Claude "remembers" across sessions.
>
> This document goes from a high-level mental model down to mid-level, function-by-function
> call traces with `file:line` references. The original design rationale lives in
> [`memory-system-handoff.md`](memory-system-handoff.md); this doc maps that design onto the
> actual code.

---

## 1. The 10,000-foot view

Three subsystems and one store:

| Component | Role |
| --- | --- |
| **Claude Code hooks** | Fire-and-forget event emitters. Never block the user on capture. The read hook (`UserPromptSubmit`) blocks briefly (≤30s) to inject memory. |
| **iii** | The orchestration backbone: ingest queue, worker functions for the write pipeline, cron jobs for maintenance. |
| **OpenAI** | All LLM reasoning — extraction, read-path query planning, gray-zone adjudication — plus embeddings (`text-embedding-3-small`, 1536-dim). |
| **HelixDB** | The memory store. Hybrid graph + vector + BM25 in one engine: canonical `Entity` nodes, typed `Memory` nodes, relational edges. |

Two asymmetric paths run over this:

- **Write path (async, latency OK):** hook → iii queue → worker → salience gate → buffer →
  flush → extract → entity-resolve → conflict-dispatch → embed → write. Nobody waits on it.
- **Read path (sync, must be fast):** `UserPromptSubmit` hook → plan → parallel Helix
  queries → deterministic rank → inject header. Claude is blocked until it returns.

```
                              ┌─────────────────────────────┐
                              │         Claude Code         │
                              │  ┌───────────────────────┐  │
                              │  │ Write hooks           │  │
                              │  │ PostToolUse / Stop /  │  │
                              │  │ PreCompact/SessionEnd │  │
                              │  └───────────┬───────────┘  │
                              │  ┌───────────┴───────────┐  │
              additionalCtx   │  │ Read hook             │  │
           ┌──────────────────┼──│ UserPromptSubmit      │  │
           │                  │  └───────────┬───────────┘  │
           ▼                  └──────────────┼──────────────┘
   (injected into prompt)                    │
                                             │ readPath (≤25s)
   emitTurnEvent (fire-and-forget)           │   ┌──────────────────────────┐
        │      ┌──────────────────────────┐  ├──▶│ OpenAI (LLM + embeddings)│
        │      │        iii engine        │  │   └──────────────────────────┘
        ▼      │  ┌────────────────────┐  │  │   ┌──────────────────────────┐
   ┌─────────┐ │  │ ingest queue       │  │  └──▶│ HelixDB                  │
   │  queue  │─┼─▶│ worker: ingestTurn │──┼──────▶│ graph + vector + BM25   │
   │ (async) │ │  │         flushSession│ │      │                          │
   └─────────┘ │  ├────────────────────┤  │      │                          │
        ▲      │  │ cron: sweepIdle,   │──┼──────▶│                          │
        │      │  │ decay, forget,     │  │      └──────────────────────────┘
        │      │  │ expire, erRepair   │  │                  ▲
        │      │  └────────────────────┘  │                  │
        │      └──────────────────────────┘   ┌──────────────┴───────────────┐
        │                                     │ MCP server recall()/remember()│
        └────── emitTurnEvent w/ topicShifted │  also → OpenAI                │
               (read hook re-enqueues turn)   └───────────────────────────────┘
```

### The spine

One signal couples the two paths: **`topicShifted`**. The read-path planner LLM (which runs
every turn anyway) emits `topic_shifted: bool` alongside the query plan. That single flag
does two things at once:

1. **Read side** — confirms a re-plan for the new topic.
2. **Write side** — the read hook attaches `topicShifted` to the turn event it enqueues;
   when the worker sees it, it flushes the write buffer to crystallize the *finished* topic.

> **Why an LLM flag and not an embedding gate?** The original design used a cheap embedding
> "drift gate." It was empirically falsified on 8 real sessions (F1 ≈ 0.44) — see
> [§8 Drift-gate experiment](#8-the-drift-gate-experiment-historical). Shift detection moved
> into the planner call, validated at recall 0.93 with `gpt-4o-mini`.

---

## 2. Repository map

```
src/
  config.ts            # TENANT_ID, USER_ID, HELIX_URL, EMBED_MODEL/DIM
  hooks/               # Claude Code hook entry points
    capture.ts         #   write hooks → TurnEvent
    emit.ts            #   emitTurnEvent: enqueue onto iii (fire-and-forget)
    inject.ts          #   UserPromptSubmit read hook → readPath → additionalContext
    silence.ts         #   redirect console/stdout→stderr so SDK noise can't pollute the hook
  iii/
    worker.ts          # registers iii functions + cron triggers (the backbone)
    drive.ts           #   async queue driver (manual test)
    drive_sync.ts      #   sync queue driver (debug)
  write/               # WRITE PATH
    ingest.ts          #   ingestTurn: salience gate → buffer → maybe flush
    salience.ts        #   per-turn heuristic gate (no LLM)
    buffer.ts          #   FileBufferStore + flushReason
    pipeline.ts        #   flushSession: the heavy lifting
    extract.ts         #   extractWindow: the one extraction LLM call
    entityResolve.ts   #   resolveEntity via matching engine
    conflict.ts        #   resolveConflict via matching engine + type policy
    remember.ts        #   on-demand write (MCP remember tool)
    types.ts           #   TurnEvent, CandidateMemory, MentionCluster, ...
    e2e.ts             #   Checkpoint-1 harness
  read/                # READ PATH
    readPath.ts        #   orchestrator
    planner.ts         #   planQuery: LLM query plan + topic_shifted
    recall.ts          #   MCP recall() tool
    rank.ts            #   deterministic ranking (no LLM)
    header.ts          #   buildHeader: format the injected block
    e2e.ts             #   Checkpoint-1 harness
  match/               # REUSABLE MATCHING ENGINE
    engine.ts          #   block → score → threshold → adjudicate-on-gray
    scorers.ts         #   cosineSim, distanceToSim, trigramSim, bestAliasSim
  llm/
    complete.ts        #   jsonComplete (HOT_MODEL = gpt-4o-mini)
    embed.ts           #   embed / embedOne (text-embedding-3-small)
  db/                  # HELIX DATA ACCESS
    schema.ts          #   labels + node/edge property shapes
    client.ts          #   helix client + writeWithRetry
    bootstrap.ts       #   idempotent index creation
    entities.ts        #   searchEntityCandidates, createEntity, addAliases
    memories.ts        #   persistMemory, supersede, linkExtends, bumpMemories, setGoalStatus
    retrieve.ts        #   recall, similarMemories, relationalFacts, validateEntities
    smoke.ts           #   write+read smoke test
  maintain/
    sweeps.ts          #   decaySweep, forgetSweep, expireContextual
    erRepair.ts        #   detectDuplicates, mergeEntities, erRepairSweep
  mcp/
    server.ts          # MCP server: recall + remember tools (stdio transport)
  audit/               # AUDIT LOG (standalone SQLite, isolated from HelixDB)
    types.ts           #   AuditActor / AuditCategory / AuditRecord shapes
    emit.ts            #   audit(): the single fire-and-forget entry point + sink dispatch
    client.ts          #   host delivery: synchronous swallowed spool append (fs-only)
    db.ts              #   worker-only node:sqlite: schema, insertBatch, queryLogs
    record.ts          #   worker in-memory batch buffer → SQLite (the sink)
    drain.ts           #   worker spool drainer (rename-rotate, ~1s)
    server.ts          #   worker GET /audit read API (dashboard proxies to it)

unimind-dashboard/          # Next.js graph-visualization UI (separate app)
experiments/drift-gate/     # the falsified embedding-gate experiment (historical)
docker-compose.yml          # minio + helix + iii + worker + dashboard
config.yaml                 # iii engine workers (queue, cron, http, observability)
```

---

## 3. The data model (HelixDB)

Defined in [`src/db/schema.ts`](../src/db/schema.ts). Everything is tenant-partitioned
(`tenant_id`) and bitemporal (`validFrom`/`validTo`).

**Nodes**

```
┌─────────────────────────────────────┐     ┌──────────────────────────────────────────┐
│ Entity                              │     │ Memory                                     │
├─────────────────────────────────────┤     ├──────────────────────────────────────────┤
│ entityKey   tenant:normName (unique)│     │ memoryId    uuid (unique)                  │
│ name                                │     │ userId                                     │
│ entityType  person|org|project|     │     │ primaryType EPISODIC|SEMANTIC|PROCEDURAL|  │
│             concept                 │     │             CONTEXTUAL|GOAL                │
│ aliases[]                           │     │ content     (BM25 field)                   │
│ aliasText   (BM25 field)            │     │ embedding   float[1536]                    │
│ embedding   float[1536]             │     │ weight      reinforcement signal           │
│ confidence                          │     │ isLatest                                   │
└─────────────────────────────────────┘     │ validFrom / validTo  (null = current)      │
                                             │ expiresAt   CONTEXTUAL TTL                  │
┌─────────────────────────────────────┐     │ deletedAt   soft-delete tombstone          │
│ Category   categoryKey, name        │     │ decayPolicy slow|evergreen|fast|           │
│ Session    sessionId, userId,       │     │             goal-lifecycle                 │
│            project, started/endedAt │     │ status      GOAL only: active|completed|   │
└─────────────────────────────────────┘     │             abandoned                      │
                                             └──────────────────────────────────────────┘
```

**Edges**

```
  Memory ──MENTIONS──▶ Entity        (memory references an entity)
  Entity ──REL───────▶ Entity        (relational memory: subject/predicate/object)
  Memory ──UPDATES───▶ Memory        (new supersedes old; keeps history)
  Memory ──EXTENDS───▶ Memory        (enriches without replacing)
  Memory ──DERIVES───▶ Memory        (inferred link)
  Memory ──IN_CATEGORY▶ Category     (tagged)
  Memory ──DERIVED_FROM▶ Session     (provenance)
```

### The six memory types

`primaryType` is not a rigid bucket — its real job is to drive **conflict semantics** and
**decay**. A second axis decides storage shape: relational memories are **edges** (`REL`),
the other five are **nodes**.

| Type | Conflict semantics | Decay (`decayPolicy`) |
| --- | --- | --- |
| `EPISODIC` | ADD-only (dedup on literal re-extraction) | `slow` |
| `PROCEDURAL` | merge / refine / version | `evergreen` (never auto-deleted) |
| `SEMANTIC` | high-bar; extend, don't destroy | `slow` |
| `CONTEXTUAL` | latest-wins; **only type hard-deleted** | `fast` (24h TTL) |
| `GOAL` | state transition (active→completed/abandoned) | `goal-lifecycle` |
| Relational (`REL` edge) | supersede with validity interval | `slow` |

### The "current scoped" filter

Every read narrows to live, current, owned memories
([`src/db/retrieve.ts:44`](../src/db/retrieve.ts)):

```
isLatest == true && deletedAt == null && validTo == null && userId == USER_ID
                 && (expiresAt == null || expiresAt > now)   // app-side for contextual
```

### Indexes

Created idempotently by [`bootstrap.ts:14`](../src/db/bootstrap.ts). Each label gets equality
indexes (key, tenant, type), a **vector** index on `embedding` (partitioned by `tenant_id`),
a **BM25** text index (`aliasText` for entities, `content` for memories), and range indexes
on `expiresAt`/`eventStartAt` for TTL and temporal recall.

---

## 4. The write path (asynchronous)

Goal: capture must never slow the user down. The hook drops a raw event on the iii queue and
returns; everything heavy happens in a worker.

```
Claude Code
   │  hook JSON (PostToolUse / Stop / ...)
   ▼
capture.ts ── toEvent() → TurnEvent
   │
   ▼
emit.ts ──── emitTurnEvent(event)
   │            iii.trigger("unimind::ingestTurn", Void)
   │            ╰─▶ returns immediately (fire-and-forget)
   ▼
iii queue
   │
   ▼
ingest.ts ── ingestTurn(store, event)
   │
   ├─ salienceGate(event) ──── fail ─▶ DROP
   │        │ pass
   │        ▼
   ├─ buffer.ts: store.append(turn)
   │
   ├─ buffer.ts: flushReason(buf, event) ── null ─▶ wait for more turns
   │        │ topic_shift | boundary | size | time_cap
   │        ▼
   └─ pipeline.ts: flushSession(store, sessionId, reason)
            │
            ├─ extract.ts: extractWindow(buf) ............ 1 LLM call
            ├─ embed.ts:   embed(entities + memories) .... 1 batch
            │
            ├─ for each mention cluster:
            │     └─ entityResolve.ts: resolveEntity(cluster, vec)
            │
            ├─ for each candidate memory:
            │     ├─ conflict.ts: resolveConflict(memory, vec)
            │     └─ db: persistMemory / supersede / linkExtends
            │
            └─ buffer.ts: store.clear(sessionId)
```

### 4.1 Capture → emit

- [`capture.ts:24`](../src/hooks/capture.ts) `toEvent(payload)` maps a Claude Code hook payload
  to a `TurnEvent` (`{sessionId, role, text, ts, project?, toolName?, boundary?}`), routing
  by `hook_event_name`; returns `null` for unsupported events. `main()` ([:50](../src/hooks/capture.ts))
  races the emit against a 3s hard cap and **always exits 0**.
- [`emit.ts:9`](../src/hooks/emit.ts) `emitTurnEvent(event)` opens an ephemeral iii worker
  connection, calls `iii.trigger("unimind::ingestTurn", event, Void())` (enqueue without
  awaiting the handler), waits 150ms to flush the WebSocket frame, then shuts down. Never
  throws.

`TurnEvent` and friends are defined in [`src/write/types.ts`](../src/write/types.ts).

### 4.2 Ingest: salience gate → buffer → flush decision

[`ingest.ts:18`](../src/write/ingest.ts) `ingestTurn(store, event, cfg)`:

1. **Salience gate** — [`salience.ts:24`](../src/write/salience.ts) `salienceGate(turn)`. Pure
   heuristics, **no LLM**: tool events always pass; empty/ack turns are dropped; otherwise it
   scores signals (`NAMED` entity-like tokens, `COMMIT`, `PREFERENCE`, `GOAL`, `ASSERTION`).
   Returns `{pass, score, signals[]}`. Fail → drop the turn.
2. **Buffer** — [`buffer.ts:51`](../src/write/buffer.ts) `FileBufferStore.append()` appends a
   `BufferedTurn` to the session's JSON file (durable, survives restarts).
3. **Flush decision** — [`buffer.ts:18`](../src/write/buffer.ts) `flushReason(buf, event, cfg)`,
   a pure function returning the first matching reason or `null`:
   - `event.topicShifted` → `"topic_shift"` (the spine signal)
   - `event.boundary` → `"boundary"` (stop / session_end / pre_compact / idle)
   - `buf.turns.length >= cfg.maxTurns` (default 8) → `"size"`
   - age ≥ `cfg.timeCapMs` (default 15m) → `"time_cap"`

If a reason fires, `ingestTurn` calls `flushSession`.

### 4.3 Flush: the heavy lifting

[`pipeline.ts:23`](../src/write/pipeline.ts) `flushSession(store, sessionId, reason)`:

1. Load buffer; early-return if empty.
2. **Extract** — `extractWindow(buf)` ([`extract.ts:56`](../src/write/extract.ts)) runs **one
   LLM call over the whole window** (`jsonComplete`, `gpt-4o-mini`, 1500 tokens). The system
   prompt instructs the model to emit self-contained memories (each classified into one of
   the six types) plus mention clusters with in-window coreference already resolved. The
   response is defensively validated/clamped. Returns
   `{memories: CandidateMemory[], clusters: MentionCluster[]}`.
3. **Embed** — one batch `embed([...entityNames, ...memoryContents])`
   ([`embed.ts:21`](../src/llm/embed.ts)), then split back into `clusterVecs` / `memVecs`.
4. **Entity resolution** — for each cluster, `resolveEntity(cluster, vec)` (§6) returns
   `{entityKey, action}`; build a `clusterIndex → entityKey` map.
5. **Conflict-dispatched writes** — for each candidate memory, `resolveConflict(memory, vec)`
   (§6) returns a `WriteAction`:
   - `skip` → duplicate; bump the existing target instead of writing.
   - otherwise → `persistMemory(...)` ([`memories.ts:36`](../src/db/memories.ts)) writes the
     `Memory` node, its `MENTIONS` edges to resolved entities, and (if relational) a `REL`
     edge between subject/object entities. Then `supersede` or `linkExtends` applies the
     edge semantics.
6. `store.clear(sessionId)` and return a `FlushSummary`.

`persistMemory` also derives `decayPolicy` + `expiresAt` from `primaryType` (PROCEDURAL →
evergreen, CONTEXTUAL → fast/24h TTL, GOAL → goal-lifecycle, else slow).

---

## 5. The read path (synchronous)

Goal: retrieval sits in Claude's critical path, so it must be fast and high-precision. The
**one LLM call is spent on query *planning*, not re-ranking** — ranking is deterministic math.

```
Claude Code ── UserPromptSubmit { prompt }
   │
   ▼
inject.ts ── main()
   │
   ▼
readPath.ts ── readPath(prompt)   (≤25s budget)
   │
   ├─ planner.ts: planQuery(prompt, recentContext) ......... 1 LLM call
   │     └─▶ { entities, topics, typesRelevant, timeScope, topicShifted }
   │
   ├─ [parallel] ─┬─ embed.ts: embedOne(queryText)
   │              └─ db: validateEntities(plan.entities)   (drop hallucinations)
   │
   ├─ [parallel] ─┬─ db: recall({queryEmbedding, queryText})
   │              │       └─ vector + BM25 + goals + contextual
   │              └─ db: relationalFacts(entityKeys)        (1-hop out+in REL)
   │
   ├─ rank.ts:   rankMemories([vector, bm25], 500)          (deterministic, no LLM)
   ├─ header.ts: buildHeader({goals, contextual, relFacts, memories})
   ├─ db: bumpMemories(usedIds)                             (fire-and-forget)
   │
   └─▶ { header, topicShifted, usedIds }
        │
inject.ts
   ├─▶ Claude Code: additionalContext (stdout JSON)
   └─▶ iii queue:   emitTurnEvent({ ...turn, topicShifted })  (re-enqueue → write flush)
```

### 5.1 The hook

[`inject.ts:37`](../src/hooks/inject.ts) `main()`:

1. **`silence.ts` must be imported first** ([`inject.ts:11`](../src/hooks/inject.ts)) — it
   redirects `console.*` and `process.stdout.write` to stderr so iii/OTel import noise can't
   corrupt the hook's stdout, which Claude Code parses for `additionalContext`. The only
   sanctioned stdout channel is `writeStdout()` ([`silence.ts:13`](../src/hooks/silence.ts)).
2. Read stdin, call `readPath(prompt)` under a 25s timeout (within Claude Code's 30s budget).
3. Log the injected header to the Checkpoint-1 log (`.unimind/checkpoint1.jsonl`).
4. **Emit the user turn carrying `topicShifted`** via `emitTurnEvent` — this is the spine
   crossing into the write side.
5. Write `{hookSpecificOutput: {additionalContext}}` to stdout (only if the header is
   non-empty — defensive dedup against a known Claude Code double-injection bug).

### 5.2 The orchestrator

[`readPath.ts:21`](../src/read/readPath.ts) `readPath(prompt, recentContext)`:

1. `planQuery(prompt, recentContext)` — §5.3.
2. In parallel: `embedOne(queryText)` and `validateEntities(plan.entities)` (drops planner
   hallucinations: exact key match, else BM25 fallback only if distance < 1.5,
   [`retrieve.ts:147`](../src/db/retrieve.ts)).
3. In parallel: `recall({queryEmbedding, queryText})` (§5.4) and
   `relationalFacts(validatedEntityKeys)` (1-hop out+in `REL` edges,
   [`retrieve.ts:117`](../src/db/retrieve.ts)).
4. `rankMemories([rec.vector, rec.bm25], 500)` — §5.5. **Goals and contextual skip ranking**
   and go straight into the header (they're already high-confidence, current state).
5. `buildHeader({goals, contextual, relFacts, memories})` — §5.6.
6. `bumpMemories(usedIds)` fire-and-forget (§7, reinforce-on-retrieval).
7. Return `{header, topicShifted, usedIds, debug}`.

### 5.3 Planner (the one LLM call)

[`planner.ts:37`](../src/read/planner.ts) `planQuery(prompt, recentContext, model=HOT_MODEL)`
sends one `jsonComplete` call (300 tokens, `gpt-4o-mini`) with the last ~6 turns of context
and returns a validated `QueryPlan`:

```ts
{ entities: string[];          // deduped, max 8
  topics: string[];            // max 4
  typesRelevant: PrimaryType[];
  timeScope: "recent" | "all" | "none";
  topicShifted: boolean }      // ← the spine signal
```

### 5.4 Parallel recall

[`retrieve.ts:66`](../src/db/retrieve.ts) `recall({queryEmbedding, queryText, k})` issues a
single Helix `readBatch` with four legs:

- **vector** — `vectorSearchNodesWith(Memory, "embedding", …)` (over-fetch 3×).
- **bm25** — `textSearchNodesWith(Memory, "content", …)` (over-fetch 3×).
- **goals** — label scan filtered to `primaryType=="GOAL" && status=="active" && current()`.
- **contextual** — label scan filtered to `primaryType=="CONTEXTUAL" && current()`.

> **Engine quirk:** an in-query `.where()` *after* a vector/BM25 search drops `$distance`, so
> the "current/live" and TTL filters are applied app-side (`liveCurrent`, `notExpired`,
> [`retrieve.ts:51`](../src/db/retrieve.ts)) and the search over-fetches 3× to compensate.

Each row is a `RecallRow` (`{memoryId, content, primaryType, weight, createdAt,
lastAccessedAt, expiresAt?, distance?}`).

### 5.5 Deterministic ranking

[`rank.ts:32`](../src/read/rank.ts) `rankMemories(lists, tokenBudget=500)`:

1. Dedup across lists by `memoryId` (keep smallest distance).
2. Score each row with `scoreRow` ([`rank.ts:23`](../src/read/rank.ts)):

   ```
   score = sim × recency × weight × priority
   ```

   - `sim` = `distanceToSim(distance)` = `1 / (1 + max(0, distance))`, or `0.7` for direct
     loads with no distance.
   - `recency` = `0.5 ^ (ageDays / 30)` (30-day half-life).
   - `weight` = stored reinforcement signal.
   - `priority` = per-type multiplier (GOAL/CONTEXTUAL 1.0, PROCEDURAL 0.9, SEMANTIC 0.85,
     EPISODIC 0.7).
3. Sort desc; greedily add rows until the ~500-token budget (1 token ≈ 4 chars) is hit.

### 5.6 Header

[`header.ts:17`](../src/read/header.ts) `buildHeader(parts)` emits a compact block wrapped in
`<unimind-memory>…</unimind-memory>`, in priority order: active goals (≤5), current state /
contextual (≤5), known relationships (≤8), then ranked memories. It also returns `usedIds`
for reinforcement.

---

## 6. The reusable matching engine

One skeleton powers three jobs: **read-path entity validation**, **write-path entity
resolution**, and **write-path conflict resolution**. The shape:
`block → score → threshold → adjudicate only the gray zone`.

[`match/engine.ts:45`](../src/match/engine.ts) `match<I, C, A>(input, cfg)`:

```
  block(input)              cheap candidate fetch
       │
       ▼
  score(input, candidate)   deterministic [0,1], sort desc
       │
       ▼
  top score?
       ├── >= high ──────▶ band = match      (no LLM)
       ├── <  low  ──────▶ band = no_match   (no LLM)
       └── in between ───▶ band = gray  ▶  adjudicate(top-K)  — LLM
```

Returns `{band, scored[], top, adjudication, usedLLM}`.

Deterministic scorers live in [`scorers.ts`](../src/match/scorers.ts): `cosineSim`,
`distanceToSim`, `trigramSim` (Jaccard over char trigrams), `bestAliasSim` (exact → 1.0,
token-containment → 0.92, else trigram), and `combine` (weighted blend).

### 6.1 Entity resolution (write side)

[`entityResolve.ts:41`](../src/write/entityResolve.ts) `resolveEntity(cluster, embedding)`:

- **block** — `searchEntityCandidates(name, embedding)`
  ([`entities.ts:21`](../src/db/entities.ts)): vector + BM25 over entities, unioned by key.
- **score** — 60% alias string similarity + 40% vector cosine.
- **thresholds** — `high = 0.86`, `low = 0.55`.
- **adjudicate** (gray only) — LLM sees top-5 candidates and decides same-entity-or-new,
  **biased toward "new node"** (under-merge: a wrong merge is near-impossible to undo, a
  missed merge is fixed later by the ER repair sweep).
- Outcome: `match`/gray-with-match → `addAliases` and link; otherwise `createEntity`.

### 6.2 Conflict resolution (write side)

[`conflict.ts:51`](../src/write/conflict.ts) `resolveConflict(candidate, embedding)`:

- **block** — `similarMemories(embedding, primaryType, k=5)`
  ([`retrieve.ts:99`](../src/db/retrieve.ts)), same-type only.
- **score** — `distanceToSim(distance)`.
- **thresholds** — `high = 0.9`, `low = 0.6`.
- **adjudicate** (gray only) — LLM classifies the relationship as
  `duplicate | update | extend | unrelated`.
- **policy dispatch** ([`conflict.ts:34`](../src/write/conflict.ts)) maps
  `(relationship × primaryType) → WriteAction`:

  | | duplicate | update | extend |
  | --- | --- | --- | --- |
  | EPISODIC | skip (ADD-only) | extend | extend |
  | SEMANTIC | skip | extend (high bar) | extend |
  | PROCEDURAL | skip | supersede | extend |
  | CONTEXTUAL | skip | supersede (hard-delete) | extend |
  | GOAL | skip | supersede | extend |

  `WriteAction` ∈ `"add" | {kind:"skip",targetId} | {kind:"extend",targetId} |
  {kind:"supersede",targetId,hardDelete}`. **Supersede never destroys** (sets `isLatest=false`,
  `validTo=now`, adds an `UPDATES` edge) except contextual, which hard-deletes.

---

## 7. Reinforce-on-retrieval

When memories are surfaced (read header or `recall`), [`memories.ts:135`](../src/db/memories.ts)
`bumpMemories(ids, boost=0.1)` increments `weight`, increments `accessCount`, and touches
`lastAccessedAt` — all fire-and-forget. This is the "use-it-or-lose-it" loop: retrieved
memories gain weight; unused ones decay and are eventually forgotten by the maintenance
sweeps (§9). One mechanism gives decay, dedup pressure, and noise control at once.

---

## 8. The drift-gate experiment (historical)

`experiments/drift-gate/` is a self-contained study that **falsified** the original design's
cheap embedding-based topic-shift detector, and is why the spine signal now lives in the
planner LLM call.

- **Method** ([`extract.ts`](../experiments/drift-gate/src/extract.ts) → mine 8 real sessions,
  138 transitions; [`label.ts`](../experiments/drift-gate/src/label.ts) → `gpt-4.1` gold labels,
  20% positive; [`eval.ts`](../experiments/drift-gate/src/eval.ts) → sweep cosine-distance
  variants).
- **Result:** best embedding variant (centroid + new-entity) peaked at **F1 ≈ 0.44**. Failure
  is structural, not tuning — in a single-project session everything is semantically close,
  and real shifts are short *intent pivots* ("commit and continue", "start T6"), not content
  distance.
- **Constructive finding:** a `gpt-4o-mini` classifier hit recall 0.93; `gpt-4.1-nano` was
  too weak (recall 0.50). So shift detection moved into the planner, tuned for recall (a
  missed shift serves stale memory; an extra re-plan is cheap at single-user scale).

Full write-up: `experiments/drift-gate/FINDINGS.md`.

---

## 9. Orchestration & maintenance (iii)

[`worker.ts:20`](../src/iii/worker.ts) registers the iii functions and cron triggers against a
persistent `unimind` worker connection.

```
  Functions (queue-triggered)            Crons (time-triggered)
  ┌──────────────────────────┐           ┌────────────────────────────────────────┐
  │ unimind::ingestTurn       │           │ sweepIdle        — every minute          │
  │   (from hooks)            │           │   flush idle buffers                     │
  │ unimind::flushSession     │           │ expireContextual — hourly                │
  │   (manual force-flush)    │           │   hard-delete expired CONTEXTUAL         │
  └──────────────────────────┘           │ decayAndForget   — daily 04:00           │
                                          │   decaySweep + forgetSweep               │
                                          │ erRepair         — daily 04:30           │
                                          │   merge duplicate entities               │
                                          └────────────────────────────────────────┘
```

| Job | File | What it does |
| --- | --- | --- |
| `sweepIdle` | [`worker.ts:38`](../src/iii/worker.ts) | Walk all buffers; flush any whose time cap passed. |
| `expireContextual` | [`sweeps.ts:56`](../src/maintain/sweeps.ts) | **Hard-delete** CONTEXTUAL memories past `expiresAt`. |
| `decaySweep` | [`sweeps.ts:20`](../src/maintain/sweeps.ts) | `weight *= 0.9` for memories idle > 7 days. |
| `forgetSweep` | [`sweeps.ts:39`](../src/maintain/sweeps.ts) | Soft-delete (`deletedAt=now`) weak (`weight<0.25`), stale (>45d idle) memories — never PROCEDURAL or GOAL. |
| `erRepairSweep` | [`erRepair.ts:80`](../src/maintain/erRepair.ts) | `detectDuplicates` (alias overlap or name-embedding cosine ≥ 0.95) then `mergeEntities` (union aliases, re-point MENTIONS, drop loser). Fixes the under-merge bias from §6.1. |

The iii engine itself is configured in [`config.yaml`](../config.yaml): in-memory `queue`, KV
`cron` (required for cron triggers), `http` REST on 3111, and an in-memory observability
worker. All DB writes go through `writeWithRetry` ([`client.ts:11`](../src/db/client.ts)), which
retries HTTP 409 conflicts with exponential backoff.

---

## 10. The MCP server (explicit pull + push)

[`mcp/server.ts:15`](../src/mcp/server.ts) runs a stdio MCP server exposing two tools:

- **`recall(query, limit=8)`** → [`read/recall.ts:17`](../src/read/recall.ts): embed the query,
  `recallDb` with a generous budget, rank **all four lists** (vector + BM25 + goals +
  contextual — unlike the push header, which excludes goals/contextual from ranking), slice
  to `limit`, reinforce, and return `{content, primaryType, score}[]`.
- **`remember(content)`** → [`write/remember.ts:10`](../src/write/remember.ts): runs an explicit
  statement through the same flush pipeline as capture (buffer → extract → resolve →
  conflict-dispatch → write), returning a summary.

Register with:

```bash
claude mcp add unimind -- npx tsx <repo>/src/mcp/server.ts
```

---

## 11. Deployment topology

[`docker-compose.yml`](../docker-compose.yml) brings up the full stack:

```
  ┌──────────────────────┐
  │ minio  S3 storage     │
  │ :9000 / :9001         │
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ minio-setup           │  (create helix-db bucket)
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ helix  enterprise-dev │◀──────────────┬───────────────┐
  │ :6969 → 8080          │               │               │
  └──────────┬───────────┘               │               │
             ▼                            │               │
  ┌──────────────────────┐               │               │
  │ iii  :49134 WS        │──────────────▶│               │
  │      :3111 REST       │               │               │
  └──────────────────────┘    ┌───────────┴──────────┐  ┌─┴────────────────────┐
                              │ worker               │◀─┤ dashboard  Next.js   │
                              │ (bootstrap+worker.ts)│  │ :48173 → 3000        │
                              │ audit GET :48180     │  │ /api/audit-logs proxy│
                              │ owns audit.db        │  └──────────────────────┘
                              └──────────┬───────────┘
                                         ▼ spool + audit.db on bind mount
                              ${HOME}/.unimind ◀── host hooks/MCP append spool
```

- **worker** ([`docker/worker.Dockerfile`](../docker/worker.Dockerfile)) runs
  [`worker-entrypoint.sh`](../docker/worker-entrypoint.sh): wait for Helix HTTP + iii WS, run
  `bootstrap.ts` (idempotent indexes), then `worker.ts`.
- Single-user config ([`src/config.ts`](../src/config.ts)): `UNIMIND_TENANT` (default
  `"unimind"`), `UNIMIND_USER` (default `"default"`), `HELIX_URL`, and a required
  `OPENAI_API_KEY`. Buffers and the checkpoint log live on the `unimind-data` volume.
- **Audit log (§13):** the worker is the sole SQLite writer. It bind-mounts `${HOME}/.unimind`
  (shared with host hooks/MCP for the spool; persists `audit.db`), drains the spool every ~1s,
  and serves the read API on `:48180`; the dashboard reads it via `WORKER_AUDIT_URL`.

---

## 12. The dashboard (visualization UI)

A standalone **Next.js 15 / React 19** app under
[`unimind-dashboard`](../unimind-dashboard) for exploring the memory graph. It
renders with `react-force-graph-2d` (D3 force + Canvas).

```
  HelixDB              lib/helix.ts            app/api/*              useGraphData.ts
  POST /v1/query  ──▶  runRead +         ──▶  nodes-edges,      ──▶  state + fetching
                       toDataItem/toEdge       nodes-by-label,            │
                                               node-connections,         ▼
                                               schema            visualize/page.tsx
                                                                 ForceGraph2D
                                                                       │
                                                                       ▼
                                                                 NodeDetailPanel.tsx
                                                                 (RHS properties)
```

- **`lib/helix.ts`** adapts enterprise-dev's POST-only `/v1/query` dynamic queries to the
  shapes the dashboard expects (`runRead`, `toDataItem`, `toEdge`; hardcoded UniMind schema).
- **API routes** (`app/api/`): `nodes-edges` (whole graph, rate-limited 500–3000 nodes),
  `nodes-by-label`, `node-connections` (single-node out/in/both expansion), `schema`.
- **`useGraphData.ts`** holds the node/edge cache and fetch logic: `loadNodes`,
  `expandNodeConnections`, `loadConnections` (batched 10 at a time).
- **`visualize/page.tsx`** wires the force graph: click → focus a node + expand its
  connections; drag/hover/zoom tuned via adaptive force config.
- **`NodeDetailPanel.tsx`** is the right-hand panel that shows a clicked node's properties
  (vectors are summarized by length; embeddings are never returned to the client).

---

## 13. Audit logs

Every memory operation — reads, writes, and every maintenance cron — is recorded to a
**standalone SQLite database** (`audit.db`), deliberately **isolated from HelixDB**, and
surfaced as a filterable table at `/dashboard/audit-logs`. The goal: reading the audit log
alone should tell the complete behind-the-scenes story of what the agent, the hooks, and the
cron jobs did to memory — *nothing omitted*.

### 13.1 Design constraints → the topology

Audit writes originate in **three different runtimes**, and a fourth must read them:

| Runtime | Lifetime | Emits |
| --- | --- | --- |
| Claude Code **hook** (`inject.ts`, `capture.ts`) | short-lived (`npx tsx`, exits per invocation) | `READ/inject`, `WRITE/capture` |
| **MCP server** (`mcp/server.ts`) | host stdio process | `READ/recall`, `WRITE/remember` |
| **iii worker** (`worker.ts`) | long-lived container | `WRITE/flush`, all `CRON/*` |
| **dashboard** (Next.js) | container | *reads* only |

SQLite is a single file behind file locking; multiple writers across host processes **and**
containers (especially over a macOS Docker bind mount) is where its locking gets unreliable.
So the rule is **one writer**: the iii worker is the **sole** process that ever opens
`audit.db`. Everyone else hands events to it, and even the dashboard reads through the worker
rather than touching the file.

This forces two delivery lanes, chosen by process lifetime:

- **Worker lane (in-process):** `audit()` pushes the record onto an **in-memory batch buffer**
  ([`record.ts`](../src/audit/record.ts)); a flusher drains it to SQLite in one transaction every
  ~500ms (or at 200 rows). True fire-and-forget.
- **Host lane (spool):** a short-lived process can't safely fire-and-forget over the network —
  it may exit before an async POST flushes. Instead `audit()` does a **synchronous, swallowed
  append** to a spool file ([`client.ts`](../src/audit/client.ts)) — microseconds, durable across
  exit, never throws. The worker **drains** the spool into SQLite every ~1s
  ([`drain.ts`](../src/audit/drain.ts)) by atomic-rename rotation (rename aside → read → insert →
  unlink; any concurrent append lands in a fresh file, so no lost lines and at-least-once
  delivery).

The lane is selected at runtime by [`emit.ts`](../src/audit/emit.ts): the worker calls
`setAuditSink()` at startup, so its `audit()` calls go to the buffer; everywhere else no sink
is set, so they spool. Critically, **only the worker ever imports `node:sqlite`** — host code
imports the fs-only `client.ts`, so the hooks can't break on a runtime without SQLite support.

> **Contract:** `audit()` is never `await`ed in memory code and never throws — an audit hiccup
> can never block or fail a memory operation. There is **no external queue**: at ~tens of
> events/sec peak, the spool file (host's durable queue) + the in-memory buffer (worker's batch
> consumer) already provide decoupling and batching with zero new infrastructure.

### 13.2 The two lanes converging on one writer

```
  HOST PROCESSES (short-lived)                      WORKER (long-lived, sole writer)
  ┌───────────────────────────┐                     ┌──────────────────────────────────┐
  │ inject.ts   READ/inject    │                     │ flushSession  WRITE/flush         │
  │ capture.ts  WRITE/capture  │   audit()           │ crons         CRON/*              │
  │ mcp recall  READ/recall    │──┐ (sync append)    │ bootstrap*    SYSTEM/bootstrap    │
  │ mcp remember WRITE/remember│  │                  └─────────────┬────────────────────┘
  └───────────────────────────┘  ▼                          audit() │ (in-process)
                            audit-spool.jsonl                        ▼
                         (~/.unimind, bind-mounted)         in-memory batch buffer
                                  │                          (flush 500ms / 200 rows)
                                  │  drain ~1s (rename→read→insert→unlink)             │
                                  └───────────────┬──────────────────────────────────┘
                                                  ▼
                                          ┌───────────────┐
                                          │   audit.db    │  (SQLite, WAL)
                                          │  audit_log    │
                                          └───────┬───────┘
                                                  │ GET /audit  (worker :48180)
                                                  ▼
                                   dashboard /api/audit-logs  (proxy)
                                                  ▼
                                   /dashboard/audit-logs  (filterable table + Categories dialog)

  * bootstrap runs as a separate one-shot process in the worker container → no sink → it
    SPOOLS its row, which the worker drains once it starts.
```

### 13.3 Per-trigger end-to-end flows

Every category is **one row per logical operation**; affected IDs, deltas, reason and timings
go in a `details` JSON column. Failures are recorded as `status="error"` rows.

```
READ/inject  (hook, host lane)
  UserPromptSubmit → inject.main → readPath(...) returns
    └─ audit({READ/inject, hook, usedIds, topicShifted, debug counts})
         → spool → worker drain (~1s) → audit.db

READ/recall  (skill, host lane)
  Claude calls recall tool → mcp/server.ts handler → read/recall.recall(...)
    └─ audit({READ/recall, skill, query, returned, types})
         → spool → drain → audit.db

WRITE/capture  (hook, host lane)
  PostToolUse/Stop/SessionEnd/PreCompact → capture.main → emitTurnEvent (enqueue)
    └─ audit({WRITE/capture, hook, hookEvent, role, toolName, boundary})
         → spool → drain → audit.db
  (the async flush this may later trigger is logged separately as WRITE/flush)

WRITE/remember  (skill, host lane)
  Claude calls remember tool → write/remember → flushSession(..., {WRITE/remember, skill})
    └─ audit({WRITE/remember, skill, +mem/superseded/entities, memoryIds})
         → spool → drain → audit.db
  (remember runs IN the MCP host process, so its flush spools — not the worker lane)

WRITE/flush  (worker, in-process lane)
  iii ingestTurn / sweepIdle → flushSession(..., default {WRITE/flush, worker})
    └─ audit({WRITE/flush, worker, reason, +mem/reinforced/superseded/entities, memoryIds})
         → in-memory buffer → batch insert → audit.db

CRON/*  (cron, in-process lane)        sweep-idle | decay | forget | expire-contextual | er-repair
  iii cron fires → maintenance fn (sweeps.ts / erRepair.ts / sweepIdle)
    └─ audit({CRON/<job>, cron, counts: decayed|forgotten|expired|merged|flushed})
         → in-memory buffer → batch insert → audit.db

SYSTEM/bootstrap  (worker, spool→drain)
  worker-entrypoint → bootstrap.ts (separate process, no sink) creates Helix indexes
    └─ audit({SYSTEM/bootstrap, worker, indexes}) → spool
         → worker.ts starts → drain → audit.db
```

### 13.4 The category taxonomy

[`audit/types.ts`](../src/audit/types.ts) — the names are the story:

| Category | Actor | Trigger / meaning |
| --- | --- | --- |
| `READ/inject` | hook | Auto memory injection on every prompt (§5). |
| `READ/recall` | skill | Explicit `recall` MCP tool (§10). |
| `WRITE/capture` | hook | A turn event was enqueued for the write pipeline (§4.1). |
| `WRITE/flush` | worker | A buffer was crystallized into memory (§4.3); `details.reason` ∈ stop/session_end/pre_compact/size/time_cap/topic_shift. |
| `WRITE/remember` | skill | Explicit `remember` MCP tool (§10). |
| `CRON/sweep-idle` | cron | Idle-buffer flush sweep, every minute (§9). |
| `CRON/decay` | cron | Daily weight decay (§9). |
| `CRON/forget` | cron | Daily soft-delete of weak/stale memories (§9). |
| `CRON/expire-contextual` | cron | Hourly hard-delete of expired CONTEXTUAL (§9). |
| `CRON/er-repair` | cron | Daily duplicate-entity merge (§9). |
| `SYSTEM/bootstrap` | worker | Idempotent Helix index creation on startup (§3, §11). |

> Reinforcement (`bumpMemories`) and entity create/link are **folded into their parent rows**
> (e.g. a `READ/inject` row carries `usedIds`; a `WRITE/flush` row carries entity deltas),
> consistent with one-row-per-logical-operation.

### 13.5 Reading it back

The worker runs a tiny HTTP read API ([`server.ts`](../src/audit/server.ts)) on `:48180`:
`GET /audit` (paginated + filtered by category/actor/status/since/q), `GET /facets`,
`GET /health`. The dashboard's [`/api/audit-logs`](../unimind-dashboard/src/app/api/audit-logs/route.ts)
route proxies to it over the compose network (`WORKER_AUDIT_URL`), so the dashboard stays a
dependency-free HTTP client — no sqlite, no file mount. The page
([`audit-logs/page.tsx`](../unimind-dashboard/src/app/dashboard/audit-logs/page.tsx))
renders a live-polling, filterable, expandable table, plus a **Categories** dialog explaining
each category with real-world examples.

---

## 14. End-to-end recap

**Writing a memory:** you type → `UserPromptSubmit`/`PostToolUse`/`Stop` hook fires →
`capture.toEvent` → `emit.emitTurnEvent` → iii queue → `worker.ingestTurn` →
`salienceGate` → `FileBufferStore.append` → `flushReason` trips (topic shift / boundary /
size / time) → `flushSession` → `extractWindow` (1 LLM call) → `embed` (1 batch) →
`resolveEntity` ×clusters → `resolveConflict` ×memories → `persistMemory` (+ `MENTIONS` /
`REL` / `UPDATES` / `EXTENDS` edges) → buffer cleared.

**Reading memory back:** you type → `UserPromptSubmit` → `inject.main` → `readPath` →
`planQuery` (1 LLM call, emits `topicShifted`) → parallel `embedOne` + `validateEntities` →
parallel `recall` (vector+BM25+goals+contextual) + `relationalFacts` → `rankMemories`
(deterministic) → `buildHeader` → injected as `additionalContext`; `bumpMemories` reinforces
what was used; the turn is re-enqueued carrying `topicShifted` to flush the write buffer.

That `topicShifted` flag closing the loop between the two paths is the system's spine.

**Auditing it all (§13):** every step above also emits a fire-and-forget `audit()` row —
hooks/MCP append to a spool file, the worker writes its own + drains the spool into a
standalone SQLite `audit.db` (~1s), and the dashboard reads it back through the worker's
`:48180` API. So `/dashboard/audit-logs` is a complete, categorized trace of every read,
write, and cron the system performed.
