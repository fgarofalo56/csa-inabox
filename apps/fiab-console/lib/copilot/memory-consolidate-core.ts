/**
 * CTS-13 — pure consolidation reducer (the "sleep cycle" logic), no Cosmos / AI
 * Search imports so dedupe/merge/contradiction/topic-promotion are unit-testable.
 * The Azure adapter (lib/azure/memory-consolidate.ts) pulls per-scope memories,
 * runs these reducers, and writes the merges/contradictions/topic-pages back.
 */

import type { MemoryRecord } from './memory-types';

/** Tokenize content for overlap scoring (lowercase words ≥ 3 chars). */
export function tokens(content: string): Set<string> {
  return new Set(
    (content || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/** Jaccard similarity of two token sets (0..1). Pure. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Salience for pick-the-survivor: confidence, then recall count, then recency. */
function salience(m: MemoryRecord): [number, number, string] {
  return [m.confidence ?? 0, m.recallCount ?? 0, m.createdAt || ''];
}

/** True when `a` outranks `b` as the survivor of a near-duplicate pair. */
export function outranks(a: MemoryRecord, b: MemoryRecord): boolean {
  const [ca, ra, ta] = salience(a);
  const [cb, rb, tb] = salience(b);
  if (ca !== cb) return ca > cb;
  if (ra !== rb) return ra > rb;
  return ta >= tb;
}

const NEGATIONS = ['not', 'no', "n't", 'never', 'without', 'stopped', 'no longer', 'cancelled', 'canceled'];

function hasNegation(content: string): boolean {
  const s = (content || '').toLowerCase();
  return NEGATIONS.some((n) => s.includes(n));
}

export interface DedupePlan {
  /** Ids to delete (the lower-salience side of each near-duplicate pair). */
  drop: string[];
  /** {keep, drop} pairs for the audit report. */
  merges: Array<{ keep: string; drop: string; similarity: number }>;
}

/**
 * Find near-duplicate memories (Jaccard ≥ threshold) and plan to drop the
 * lower-salience side of each cluster. Greedy union-find-free: iterate pairs,
 * once an id is marked dropped it can't also be a survivor. Pure.
 */
export function planDedupe(records: MemoryRecord[], threshold = 0.6): DedupePlan {
  const toks = records.map((r) => tokens(r.content));
  const dropped = new Set<string>();
  const merges: DedupePlan['merges'] = [];
  for (let i = 0; i < records.length; i++) {
    if (dropped.has(records[i].id)) continue;
    for (let j = i + 1; j < records.length; j++) {
      if (dropped.has(records[j].id)) continue;
      const sim = jaccard(toks[i], toks[j]);
      if (sim < threshold) continue;
      // Contradictions (high overlap but opposite polarity) are NOT merged —
      // they are surfaced separately so a human resolves them.
      if (hasNegation(records[i].content) !== hasNegation(records[j].content)) continue;
      const keep = outranks(records[i], records[j]) ? records[i] : records[j];
      const drop = keep.id === records[i].id ? records[j] : records[i];
      dropped.add(drop.id);
      merges.push({ keep: keep.id, drop: drop.id, similarity: Number(sim.toFixed(3)) });
    }
  }
  return { drop: [...dropped], merges };
}

export interface Contradiction {
  a: string;
  b: string;
  similarity: number;
}

/** Flag pairs with high topical overlap but opposite polarity (one negates the
 *  other) — candidate contradictions for the review queue. Pure. */
export function detectContradictions(records: MemoryRecord[], threshold = 0.5): Contradiction[] {
  const toks = records.map((r) => tokens(r.content));
  const out: Contradiction[] = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const sim = jaccard(toks[i], toks[j]);
      if (sim < threshold) continue;
      if (hasNegation(records[i].content) !== hasNegation(records[j].content)) {
        out.push({ a: records[i].id, b: records[j].id, similarity: Number(sim.toFixed(3)) });
      }
    }
  }
  return out;
}

export interface TopicPage {
  tag: string;
  count: number;
  memoryIds: string[];
}

/** Promote tags that recur across ≥ minCount memories into topic pages. Pure. */
export function promoteTopics(records: MemoryRecord[], minCount = 3): TopicPage[] {
  const byTag = new Map<string, string[]>();
  for (const r of records) {
    for (const tag of r.tags || []) {
      const key = tag.toLowerCase().trim();
      if (!key) continue;
      const list = byTag.get(key) || [];
      list.push(r.id);
      byTag.set(key, list);
    }
  }
  const out: TopicPage[] = [];
  for (const [tag, ids] of byTag) {
    if (ids.length >= minCount) out.push({ tag, count: ids.length, memoryIds: ids });
  }
  return out.sort((a, b) => b.count - a.count);
}

export interface ConsolidationReport {
  scopeKey: string;
  scanned: number;
  merged: number;
  contradictions: number;
  topics: number;
  at: string;
}
