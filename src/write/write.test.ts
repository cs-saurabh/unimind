import { test } from "node:test";
import assert from "node:assert/strict";
import { salienceGate } from "./salience.js";
import { flushReason, DEFAULT_FLUSH } from "./buffer.js";
import type { TurnEvent, SessionBuffer } from "./types.js";

const turn = (text: string, extra: Partial<TurnEvent> = {}): TurnEvent => ({
  sessionId: "s", role: "user", text, ts: "2026-06-22T10:00:00Z", ...extra,
});

test("salience: drops filler and trivial turns", () => {
  for (const t of ["ok thanks", "yes", "got it", "hi", "continue"]) {
    assert.equal(salienceGate(turn(t)).pass, false, `should drop: ${t}`);
  }
});

test("salience: keeps commitments, preferences, goals, assertions", () => {
  assert.ok(salienceGate(turn("let's refactor the AuthModule before launch")).pass);
  assert.ok(salienceGate(turn("I prefer tabs over spaces by default")).pass);
  assert.ok(salienceGate(turn("the goal is to ship metering by Friday")).pass);
  assert.ok(salienceGate(turn("Sarah is the Engineering lead")).pass);
});

test("salience: tool events always pass", () => {
  assert.ok(salienceGate(turn("ran build", { role: "tool", toolName: "Bash" })).pass);
});

test("salience: signals are reported", () => {
  const v = salienceGate(turn("I prefer the FooBar approach"));
  assert.ok(v.signals.includes("preference"));
  assert.ok(v.signals.includes("named_entity"));
});

// ---- flush triggers ----
const buf = (n: number, openedAt = "2026-06-22T10:00:00Z"): SessionBuffer => ({
  sessionId: "s", turns: Array.from({ length: n }, () => ({ role: "user" as const, text: "x", ts: openedAt, signals: [] })),
  openedAt, lastTurnAt: openedAt,
});

test("flush: empty buffer never flushes", () => {
  assert.equal(flushReason(buf(0), turn("x", { boundary: "stop" })), null);
});

test("flush: topic shift wins (the spine signal)", () => {
  assert.equal(flushReason(buf(1), turn("x", { topicShifted: true })), "topic_shift");
});

test("flush: boundary flushes a non-empty buffer", () => {
  assert.equal(flushReason(buf(2), turn("x", { boundary: "session_end" })), "boundary");
});

test("flush: size trigger at maxTurns", () => {
  assert.equal(flushReason(buf(DEFAULT_FLUSH.maxTurns), turn("x")), "size");
  assert.equal(flushReason(buf(DEFAULT_FLUSH.maxTurns - 1), turn("x")), null);
});

test("flush: time cap", () => {
  const late = "2026-06-22T10:20:00Z"; // 20 min > 15 min cap
  assert.equal(flushReason(buf(1), turn("x", { ts: late })), "time_cap");
});

test("flush: precedence — topic shift over size", () => {
  assert.equal(flushReason(buf(DEFAULT_FLUSH.maxTurns + 5), turn("x", { topicShifted: true })), "topic_shift");
});
