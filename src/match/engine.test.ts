import { test } from "node:test";
import assert from "node:assert/strict";
import { match, type Scored } from "./engine.js";
import { cosineSim, trigramSim, bestAliasSim, distanceToSim, combine } from "./scorers.js";

type Cand = { id: string; s: number };
const blockOf = (scores: number[]) => () => scores.map((s, i) => ({ id: `c${i}`, s }));
const scoreOf = (_i: unknown, c: Cand) => c.s;

test("confident match: top >= high, no LLM, sorted desc", async () => {
  let llm = 0;
  const r = await match<null, Cand, string>(null, {
    block: blockOf([0.4, 0.95, 0.6]),
    score: scoreOf, high: 0.85, low: 0.4,
    adjudicate: async () => { llm++; return "x"; },
  });
  assert.equal(r.band, "match");
  assert.equal(r.usedLLM, false);
  assert.equal(llm, 0);
  assert.equal(r.top?.candidate.id, "c1"); // highest score first
  assert.deepEqual(r.scored.map((x) => x.score), [0.95, 0.6, 0.4]);
});

test("confident no_match: top < low, no LLM", async () => {
  let llm = 0;
  const r = await match<null, Cand, string>(null, {
    block: blockOf([0.2, 0.35]),
    score: scoreOf, high: 0.85, low: 0.4,
    adjudicate: async () => { llm++; return "x"; },
  });
  assert.equal(r.band, "no_match");
  assert.equal(r.usedLLM, false);
  assert.equal(llm, 0);
});

test("empty candidates → no_match, top null, no LLM", async () => {
  let llm = 0;
  const r = await match<null, Cand, string>(null, {
    block: () => [], score: scoreOf, high: 0.85, low: 0.4,
    adjudicate: async () => { llm++; return "x"; },
  });
  assert.equal(r.band, "no_match");
  assert.equal(r.top, null);
  assert.equal(llm, 0);
});

test("gray band runs the adjudicator on a capped set", async () => {
  let seen: Scored<Cand>[] = [];
  const r = await match<null, Cand, string>(null, {
    block: blockOf([0.7, 0.65, 0.6, 0.55, 0.5, 0.45]),
    score: scoreOf, high: 0.85, low: 0.4, grayLimit: 3,
    adjudicate: async (_i, gray) => { seen = gray; return "linked-c0"; },
  });
  assert.equal(r.band, "gray");
  assert.equal(r.usedLLM, true);
  assert.equal(r.adjudication, "linked-c0");
  assert.equal(seen.length, 3); // grayLimit honored
  assert.equal(seen[0].candidate.id, "c0");
});

test("gray band with no adjudicator surfaces gray, no LLM", async () => {
  const r = await match<null, Cand, string>(null, {
    block: blockOf([0.7]), score: scoreOf, high: 0.85, low: 0.4,
  });
  assert.equal(r.band, "gray");
  assert.equal(r.usedLLM, false);
  assert.equal(r.adjudication, null);
});

test("invalid thresholds (high < low) throws", async () => {
  await assert.rejects(
    match<null, Cand, string>(null, { block: blockOf([0.5]), score: scoreOf, high: 0.3, low: 0.6 }),
    /high.*must be >= low/,
  );
});

// ---- scorers ----

test("cosineSim: identical = 1, orthogonal = 0, negative clamps to 0", () => {
  assert.equal(cosineSim([1, 0], [1, 0]), 1);
  assert.equal(cosineSim([1, 0], [0, 1]), 0);
  assert.equal(cosineSim([1, 0], [-1, 0]), 0);
  assert.equal(cosineSim([1, 2], []), 0);
});

test("distanceToSim: monotonic decreasing", () => {
  assert.equal(distanceToSim(0), 1);
  assert.ok(distanceToSim(0.2) > distanceToSim(0.4));
});

test("trigramSim: exact=1, related>unrelated", () => {
  assert.equal(trigramSim("Engineering", "engineering"), 1);
  assert.ok(trigramSim("Sarah Chen", "Sarah Chenn") > trigramSim("Sarah Chen", "Bob Smith"));
});

test("bestAliasSim: matches any surface form; exact token strong", () => {
  assert.equal(bestAliasSim("Sarah", ["Sarah Chen", "S. Chen", "Sarah"]), 1);
  assert.ok(bestAliasSim("Sarah", ["Sarah Chen", "eng lead"]) >= 0.9); // exact token containment
  assert.ok(bestAliasSim("Sarah", ["Bob", "Alice"]) < 0.4);
});

test("combine: weighted blend normalized", () => {
  assert.equal(combine([{ score: 1, weight: 1 }, { score: 0, weight: 1 }]), 0.5);
  assert.ok(Math.abs(combine([{ score: 0.8, weight: 3 }, { score: 0.4, weight: 1 }]) - 0.7) < 1e-9);
  assert.equal(combine([]), 0);
});
