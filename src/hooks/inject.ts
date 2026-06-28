/**
 * Claude Code UserPromptSubmit hook (§7 read path; §5.13 — additionalContext injection
 * is feasible). One detector, two effects (§8): the planner's topic_shifted both
 * re-plans retrieval (inject here) and flushes the write buffer (via the enqueued turn).
 *
 * Outputs additionalContext JSON on stdout (≤30s budget). Resilient: any failure →
 * inject nothing, exit 0, never block the user. Logs every injection for CHECKPOINT 1.
 *
 * Wire in ~/.claude/settings.json: UserPromptSubmit → npx tsx <repo>/src/hooks/inject.ts
 */
import { writeStdout } from "./silence.js"; // MUST be first — isolates stdout before the SDK loads
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readPath } from "../read/readPath.js";
import { emitTurnEvent } from "./emit.js";
import type { TurnEvent } from "../write/types.js";
import { audit } from "../audit/emit.js";

// Absolute by default: this hook runs in every project's cwd, so a relative path
// would scatter a .unimind/ folder into each repo. Centralize under the home dir.
const CHECKPOINT_LOG = process.env.UNIMIND_CHECKPOINT_LOG ?? join(homedir(), ".unimind", "checkpoint1.jsonl");

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function logCheckpoint(entry: object) {
  try {
    mkdirSync(join(CHECKPOINT_LOG, ".."), { recursive: true });
    appendFileSync(CHECKPOINT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* ignore */ }
}

async function main() {
  let injected = "";
  try {
    const raw = await readStdin();
    const p = raw ? JSON.parse(raw) : {};
    const prompt: string = p.prompt ?? "";
    const sessionId: string = p.session_id ?? "unknown";
    if (prompt.trim()) {
      const startedAt = Date.now();
      const res = await Promise.race([
        readPath(prompt),
        new Promise<null>((r) => setTimeout(() => r(null), 25_000)), // stay under the 30s budget
      ]);
      if (res) {
        injected = res.header;
        logCheckpoint({ prompt: prompt.slice(0, 400), header: res.header, debug: res.debug });

        // Audit the read (host → spool, fire-and-forget). bumpMemories folds in as usedIds.
        audit({
          category: "READ/inject", actor: "hook", sessionId,
          summary: `injected ${res.usedIds.length} memory(ies)` +
            (res.topicShifted ? " (topic shift)" : "") + ` for "${prompt.slice(0, 60)}"`,
          details: {
            promptPreview: prompt.slice(0, 200),
            topicShifted: res.topicShifted,
            task_type: res.debug.taskType,
            criticality: res.debug.criticality,
            token_budget: res.debug.tokenBudget,
            token_budget_used: res.debug.budgetUsedTokens,
            token_budget_utilization: res.debug.budgetUtilization,
            memory_backstop_tripped: res.debug.backstopTripped,
            budget_limited: res.debug.budgetLimited,
            header_tokens: res.debug.headerTokens,
            injected_count: res.usedIds.length,
            naive_fallback: res.debug.naiveFallback,
            read_mode: res.debug.readMode,
            fallback_reason: res.debug.fallbackReason,
            annotations: res.debug.annotations,
            injected: res.usedIds.length,
            usedIds: res.usedIds,
            entitiesValidated: res.debug.entitiesValidated,
            counts: res.debug.counts,
            taskType: res.debug.taskType,
            taskConfidence: res.debug.taskConfidence,
            fallbackRanking: res.debug.fallbackRanking,
          },
          durationMs: Date.now() - startedAt,
        });

        // Spine: enqueue the user turn carrying topic_shifted (write-side flush). Fire-and-forget.
        const event: TurnEvent = {
          sessionId, role: "user", text: prompt, ts: new Date().toISOString(),
          project: p.cwd, topicShifted: res.topicShifted,
        };
        await Promise.race([emitTurnEvent(event), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
      } else {
        // Read path exceeded the budget — record the degraded read so the log stays complete.
        audit({
          category: "READ/inject", actor: "hook", status: "error", sessionId,
          summary: `inject timed out (>25s) for "${prompt.slice(0, 60)}"`,
          details: { promptPreview: prompt.slice(0, 200), timedOut: true },
          durationMs: Date.now() - startedAt,
        });
      }
    }
  } catch { /* swallow — never break the session */ }

  // Inject only when we have something (dedupe defensively per the §7 known gotcha).
  // writeStdout is the ONLY thing allowed to reach the real stdout (see silence.ts).
  if (injected) {
    writeStdout(JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: injected },
    }));
  }
  process.exit(0);
}

main();
