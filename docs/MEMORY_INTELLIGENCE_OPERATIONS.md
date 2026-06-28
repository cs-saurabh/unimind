# Memory Intelligence Operations

This guide is the Phase 5 hardening reference for the Memory Intelligence Layer. It explains how the daily synthesis sweep runs, how the read path degrades safely, what to monitor, and what to do when signals turn unhealthy.

## 1. Runtime map

- `src/iii/worker.ts`
  - owns cron orchestration
  - runs `CRON/sweep-idle`, `CRON/decay`, `CRON/forget`, `CRON/expire-contextual`, `CRON/synthesis`, and `CRON/er-repair`
  - is the sole SQLite audit writer
- `src/maintain/synthesis.ts`
  - executes pattern detection, contradiction detection, gap detection, and confidence decay
  - returns a per-phase summary that is written into the `CRON/synthesis` audit row
- `src/read/readPath.ts`
  - synchronous push-path for `UserPromptSubmit`
  - planner-driven by default, with naive recall fallback on failure
- `src/read/recall.ts`
  - explicit MCP pull-path
  - planner-driven by default, with the same naive recall fallback on failure
- `src/hooks/inject.ts`
  - emits `READ/inject` audit rows with latency, budget, backstop, and fallback diagnostics
- `src/mcp/server.ts`
  - emits `READ/recall` audit rows with the same diagnostics
- `unimind-dashboard/src/app/dashboard/observability/page.tsx`
  - primary monitoring and operations view for synthesis health, read-path metrics, gaps, contradictions, and help

## 2. Synthesis internals

The daily synthesis cron is triggered by `unimind::synthesizeSweep` at 11:00.

Execution order:

1. Pattern detection creates or refreshes synthetic insights.
2. Contradiction detection flags neutral disagreement pairs.
3. Gap detection creates bounded `knowledge_gap` memories.
4. Confidence decay applies only to eligible non-evergreen, non-contextual memories.

Hardening behavior:

- Each phase already isolates its own failure inside `synthesizeSweep()`, so partial work is summarized instead of crashing the whole sweep.
- The worker now retries the full sweep with exponential backoff.
- Retry metadata is written into the final `CRON/synthesis` audit row:
  - `retry_attempts`
  - `retry_recovered`
  - `retry_backoff_ms`
- If all three attempts fail, the worker emits a notification signal by:
  - logging an alert to stderr
  - writing an error audit row with `alert_code: "synthesis_retry_exhausted"` and `notified: true`

## 3. Read-path architecture

Default path:

1. `planQuery()` infers entities, topics, task type, criticality, and `topicShifted`.
2. Query embedding is computed from the prompt plus planner topics.
3. The system runs memory recall plus relational fact lookup.
4. `rankMemoriesWithStats()` applies confidence/freshness penalties and token-budget selection.
5. `buildHeader()` formats the push header or recall payload.

Graceful degradation:

- If planner-driven read execution fails, the system falls back to naive recall.
- Naive recall:
  - uses the raw prompt only
  - skips planner-specific entity traversal
  - uses the neutral `exploration / medium / 0 confidence` plan
- The fallback is visible in audit rows through:
  - `naive_fallback`
  - `read_mode`
  - `fallback_reason`

This means read failure no longer collapses immediately to “inject nothing” unless both the primary path and the naive fallback fail.

## 4. Monitoring signals

The dashboard monitoring section is driven from:

- `CRON/synthesis` audit rows
- `READ/inject` audit rows
- `READ/recall` audit rows
- current `knowledge_gap` memories in Helix

Tracked synthesis signals:

- latest run timestamp
- latest duration
- 7-day daily report:
  - insights created
  - insights updated
  - contradictions flagged
  - gaps created
  - validation rejected
- active alerts:
  - no synthesis row by 11:30
  - contradictions flagged > 50 in one run
  - `validation_rejected` spike versus recent history
  - synthesis duration > 5 minutes

Tracked read-path signals:

- p50 / p95 / p99 latency
- hit rate
- average token-budget utilization
- p95 budget utilization
- ~10-memory backstop trip rate
- naive fallback rate

Tracked gap trend signals:

- total open
- total closed
- closed in last 7 days
- 7-day opened/closed daily trend

## 5. Audit fields

`READ/inject` and `READ/recall` now carry:

- `token_budget`
- `token_budget_used`
- `token_budget_utilization`
- `memory_backstop_tripped`
- `budget_limited`
- `naive_fallback`
- `read_mode`
- `fallback_reason`

`CRON/synthesis` now additionally carries retry metadata when relevant:

- `retry_attempts`
- `retry_recovered`
- `retry_backoff_ms`
- `attempt_errors` on total failure
- `alert_code`
- `notified`

## 6. Operational playbook

When synthesis overrun fires:

1. Open the dashboard Observability page and inspect the latest synthesis rows.
2. If there is no row for today, inspect worker logs around 11:00-11:30.
3. Look for `synthesis_retry_exhausted` or repeated phase errors.

When contradiction over-flagging fires:

1. Open the latest synthesis run.
2. Check `contradictions_flagged`.
3. Review recent contradiction pairs in the dashboard before trusting the output.

When validation rejection spikes:

1. Open the latest synthesis run.
2. Inspect `validation_rejected`.
3. Cross-check recent schema or synthesis changes before re-running the cron.

When read fallback rate climbs:

1. Check `READ/inject` and `READ/recall` rows in Audit Logs.
2. Filter for `naive_fallback: true`.
3. Inspect `fallback_reason` for planner, embedding, or retrieval failures.

## 7. Deploy checklist

Before rollout:

- run root tests: `npm test`
- run dashboard build: `cd unimind-dashboard && npm run build`
- verify the worker can still write audit rows and serve the audit proxy
- verify the observability page loads all four data sections:
  - monitoring
  - synthesis audit
  - gap lifecycle
  - contradiction viewer

After rollout:

- confirm today’s `CRON/synthesis` row appears
- confirm `READ/inject` rows show utilization and fallback fields
- confirm the monitoring section reports sane sample sizes and latencies
