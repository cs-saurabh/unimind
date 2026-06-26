/**
 * Deterministic scoring primitives shared by the matching engine's `score` step.
 * No LLM, no I/O — pure functions over already-fetched candidates.
 */

/** Cosine similarity of two equal-length vectors, mapped to [0,1]. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  // cosine is [-1,1]; clamp negatives to 0 so it reads as a [0,1] similarity.
  return Math.max(0, Math.min(1, dot / denom));
}

/** Convert a Helix vector `$distance` (smaller = closer) to a [0,1] similarity. */
export const distanceToSim = (distance: number) => 1 / (1 + Math.max(0, distance));

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function trigrams(s: string): Set<string> {
  const t = `  ${normalize(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Trigram Jaccard similarity of two strings, [0,1]. Robust to minor surface variation. */
export function trigramSim(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = trigrams(a), tb = trigrams(b);
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Best string similarity of a query against any of a candidate's surface forms
 * (e.g. an Entity's name + aliases). Exact-token containment counts as a strong match.
 */
export function bestAliasSim(query: string, surfaceForms: string[]): number {
  const nq = normalize(query);
  let best = 0;
  for (const form of surfaceForms) {
    const nf = normalize(form);
    if (!nf) continue;
    if (nf === nq) return 1;
    const tokens = new Set(nf.split(" "));
    const exactToken = nq.split(" ").every((tok) => tokens.has(tok)) && nq.length > 0;
    best = Math.max(best, exactToken ? 0.92 : trigramSim(query, form));
  }
  return best;
}

/** Weighted blend of named sub-scores, normalized by total weight. */
export function combine(parts: Array<{ score: number; weight: number }>): number {
  const tw = parts.reduce((s, p) => s + p.weight, 0);
  if (tw === 0) return 0;
  return parts.reduce((s, p) => s + p.score * p.weight, 0) / tw;
}
