/**
 * On-demand memory write (the "remember" path). Runs an explicit statement through the
 * SAME pipeline as background capture — extract → entity-resolve → conflict-resolve →
 * persist — so a user-requested memory gets identical treatment (typing, entity linking,
 * dedup/supersede) as one captured automatically.
 */
import { MemoryBufferStore } from "./buffer.js";
import { flushSession, type FlushSummary } from "./pipeline.js";

export async function remember(content: string): Promise<FlushSummary> {
  const store = new MemoryBufferStore();
  const sessionId = `remember-${Date.now()}`;
  const ts = new Date().toISOString();
  await store.append(
    sessionId,
    { role: "user", text: content.trim(), ts, signals: ["explicit_remember"] },
    { ts },
  );
  // "manual" flush → extract over the one-turn window, resolve entities, dispatch conflicts, write.
  // Audit as WRITE/remember (skill), distinguishing the explicit tool from background flushes.
  return flushSession(store, sessionId, "manual", { category: "WRITE/remember", actor: "skill" });
}













