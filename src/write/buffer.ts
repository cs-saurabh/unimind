/**
 * Session-window buffer + flush-trigger logic (§7 write steps 3). The buffer lives
 * behind a small BufferStore seam: a worker-local store works for the single-user
 * tool today; swapping in iii distributed state (scope=sessionId) is a drop-in when
 * capture fans across workers. Flush triggers (§7): topic shift OR size N OR a
 * boundary OR a time cap.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionBuffer, BufferedTurn, TurnEvent, FlushReason } from "./types.js";

export interface FlushConfig {
  maxTurns: number; // size trigger N (§11 tunable)
  timeCapMs: number; // wall-clock cap since openedAt (§11 tunable)
}
export const DEFAULT_FLUSH: FlushConfig = { maxTurns: 8, timeCapMs: 15 * 60_000 };

/** Returns the flush reason if the buffer should flush now, else null. Pure. */
export function flushReason(
  buf: SessionBuffer,
  event: TurnEvent,
  cfg: FlushConfig = DEFAULT_FLUSH,
): FlushReason | null {
  if (buf.turns.length === 0) return null; // nothing to crystallize
  if (event.topicShifted) return "topic_shift"; // the spine signal (§5.12)
  if (event.boundary) return "boundary";
  if (buf.turns.length >= cfg.maxTurns) return "size";
  const age = Date.parse(event.ts) - Date.parse(buf.openedAt);
  if (age >= cfg.timeCapMs) return "time_cap";
  return null;
}

export interface BufferStore {
  get(sessionId: string): Promise<SessionBuffer | null>;
  append(sessionId: string, turn: BufferedTurn, meta: { project?: string; ts: string }): Promise<SessionBuffer>;
  clear(sessionId: string): Promise<void>;
  /** All open buffers — used by the idle-flush sweep. */
  list(): Promise<SessionBuffer[]>;
}

/** File-backed store: durable across hook processes, sufficient for single-user. */
export class FileBufferStore implements BufferStore {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }
  private path(id: string) { return join(this.dir, `${id.replace(/[^\w.-]/g, "_")}.json`); }

  async get(sessionId: string): Promise<SessionBuffer | null> {
    const p = this.path(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  }
  async append(sessionId: string, turn: BufferedTurn, meta: { project?: string; ts: string }): Promise<SessionBuffer> {
    const existing = await this.get(sessionId);
    const buf: SessionBuffer = existing ?? {
      sessionId, project: meta.project, turns: [], openedAt: meta.ts, lastTurnAt: meta.ts,
    };
    buf.turns.push(turn);
    buf.lastTurnAt = meta.ts;
    if (meta.project && !buf.project) buf.project = meta.project;
    writeFileSync(this.path(sessionId), JSON.stringify(buf));
    return buf;
  }
  async clear(sessionId: string): Promise<void> {
    const p = this.path(sessionId);
    if (existsSync(p)) rmSync(p);
  }
  async list(): Promise<SessionBuffer[]> {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as SessionBuffer);
  }
}

/** In-memory store for tests. */
export class MemoryBufferStore implements BufferStore {
  private m = new Map<string, SessionBuffer>();
  async get(id: string) { return this.m.get(id) ?? null; }
  async append(id: string, turn: BufferedTurn, meta: { project?: string; ts: string }) {
    const buf = this.m.get(id) ?? { sessionId: id, project: meta.project, turns: [], openedAt: meta.ts, lastTurnAt: meta.ts };
    buf.turns.push(turn); buf.lastTurnAt = meta.ts;
    if (meta.project && !buf.project) buf.project = meta.project;
    this.m.set(id, buf);
    return buf;
  }
  async clear(id: string) { this.m.delete(id); }
  async list() { return [...this.m.values()]; }
}
