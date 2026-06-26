/**
 * Claude Code write-path hook entry. Reads the hook JSON payload from stdin, maps it
 * to a TurnEvent, and fire-and-forget enqueues it. MUST be resilient: it always exits 0
 * and never throws, so a memory hiccup can never block or break the user's session.
 *
 * Wire into ~/.claude/settings.json (the harness runs these, not Claude):
 *   PostToolUse / Stop / SessionEnd / PreCompact / UserPromptSubmit →
 *     command: npx tsx <repo>/src/hooks/capture.ts
 */
import "./silence.js"; // MUST be first — keep SDK/OTel logging off stdout
import { emitTurnEvent } from "./emit.js";
import type { TurnEvent } from "../write/types.js";
import { audit } from "../audit/emit.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000); // never hang waiting on stdin
  });
}

/** Map a Claude Code hook payload to a TurnEvent (or null to skip). */
function toEvent(p: any): TurnEvent | null {
  const sessionId = p.session_id ?? p.sessionId ?? "unknown";
  const ts = new Date().toISOString();
  const project = p.cwd;
  const base = { sessionId, ts, project };

  switch (p.hook_event_name) {
    case "UserPromptSubmit":
      return p.prompt ? { ...base, role: "user", text: String(p.prompt) } : null;
    case "PostToolUse": {
      const name = p.tool_name ?? "tool";
      const input = p.tool_input ? JSON.stringify(p.tool_input).slice(0, 600) : "";
      return { ...base, role: "tool", toolName: name, text: `${name} ${input}`.trim() };
    }
    case "Stop":
      return { ...base, role: "assistant", text: "", boundary: "stop" };
    case "SessionEnd":
      return { ...base, role: "assistant", text: "", boundary: "session_end" };
    case "PreCompact":
      return { ...base, role: "assistant", text: "", boundary: "pre_compact" };
    default:
      return null;
  }
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    const event = toEvent(payload);
    if (event) {
      const startedAt = Date.now();
      await Promise.race([
        emitTurnEvent(event),
        new Promise((r) => setTimeout(r, 3000)), // hard cap so the hook returns fast
      ]);
      // Audit the capture-enqueue (host → spool). The async flush it may trigger is
      // logged separately as WRITE/flush by the worker.
      audit({
        category: "WRITE/capture", actor: "hook", sessionId: event.sessionId,
        summary: `enqueued ${event.role}${event.toolName ? ` ${event.toolName}` : ""}${event.boundary ? ` (${event.boundary})` : ""} turn`,
        details: {
          hookEvent: payload.hook_event_name, role: event.role,
          toolName: event.toolName, boundary: event.boundary, textLen: event.text?.length ?? 0,
        },
        durationMs: Date.now() - startedAt,
      });
    }
  } catch {
    /* swallow — never break the session over memory capture */
  } finally {
    process.exit(0);
  }
}

main();
