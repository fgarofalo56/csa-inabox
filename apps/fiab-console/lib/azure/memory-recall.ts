/**
 * CTS-08 — layered memory recall into the Copilot prompt.
 *
 * `getLayeredContext` assembles the memory system message the orchestrator injects
 * alongside the persona/skill blocks, within a token budget:
 *   L0  identity + stable preferences (always, cheap)
 *   L1  high-confidence durable facts/decisions/context (confidence ≥ 0.7)
 *   L2  query-relevant memories via the AI Search vector mirror across the USER +
 *       WORKSPACE scopes, deduped — degrading to a Cosmos keyword/tag scan when the
 *       vector mirror is unconfigured/unavailable (honest gate, never breaks the turn)
 *
 * The pure packing (priority + budget + dedupe) lives in memory-recall-core.ts so
 * it is unit-testable; this module is the Cosmos + vector I/O adapter. Recalled
 * memories are returned so the orchestrator can (a) size the CTS-05 `memory`
 * segment and (b) surface them as CTS-04 memory citations, and their recall
 * salience is reinforced (CTS-13) fire-and-forget.
 */

import {
  isMemoryBrainEnabled,
  listByCategory,
  keywordScan,
  getByIds,
  reinforceRecall,
  scopeKeysForActor,
} from './memory-store';
import { searchMemoryVector, isMemoryVectorConfigured } from './memory-vector-index';
import { packLayeredMemories, type RecallLayer } from '@/lib/copilot/memory-recall-core';
import type { MemoryActor, MemoryRecord } from '@/lib/copilot/memory-types';

const intEnv = (name: string, def: number) => Math.max(0, parseInt(process.env[name] || String(def), 10) || def);

/** Recall is default-ON; a tenant admin opts out via LOOM_COPILOT_MEMORY_RECALL_ENABLED=false. */
export function isMemoryRecallEnabled(): boolean {
  const v = (process.env.LOOM_COPILOT_MEMORY_RECALL_ENABLED || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return isMemoryBrainEnabled();
}

export interface LayeredContext {
  /** The rendered system-message block ('' when nothing recalled / disabled). */
  block: string;
  /** The memories selected into the block (for CTS-04 citations). */
  memories: MemoryRecord[];
  /** Token size of the block (feeds the CTS-05 memory segment). */
  tokens: number;
  /** Which recall path served L2. */
  backend: 'vector' | 'keyword' | 'none';
}

const EMPTY: LayeredContext = { block: '', memories: [], tokens: 0, backend: 'none' };

/**
 * Recall the layered memory context for a turn. Fails OPEN — any error yields an
 * empty context so a memory hiccup never breaks the chat. `tokenBudget` caps the
 * injected block (default LOOM_COPILOT_MEMORY_RECALL_MAX_TOKENS, ~700).
 */
export async function getLayeredContext(
  userOid: string,
  workspaceId: string | null | undefined,
  query: string,
  tokenBudget?: number,
): Promise<LayeredContext> {
  if (!userOid || !isMemoryRecallEnabled()) return EMPTY;
  const actor: MemoryActor = { userOid, workspaceId: workspaceId || undefined };
  const scopeKeys = scopeKeysForActor(actor);
  const budget = tokenBudget ?? intEnv('LOOM_COPILOT_MEMORY_RECALL_MAX_TOKENS', 700);
  const l0Limit = intEnv('LOOM_COPILOT_MEMORY_L0_LIMIT', 6);
  const l1Limit = intEnv('LOOM_COPILOT_MEMORY_L1_LIMIT', 8);
  const l2Limit = intEnv('LOOM_COPILOT_MEMORY_L2_TOPK', 10);

  try {
    // L0 identity/preferences + L1 high-confidence facts run in parallel with L2.
    const [identity, prefs, facts, relevant] = await Promise.all([
      listByCategory(scopeKeys, ['identity'], 0.4, l0Limit).catch(() => [] as MemoryRecord[]),
      listByCategory(scopeKeys, ['preference'], 0.5, l0Limit).catch(() => [] as MemoryRecord[]),
      listByCategory(scopeKeys, ['fact', 'decision', 'context'], 0.7, l1Limit).catch(() => [] as MemoryRecord[]),
      recallRelevant(scopeKeys, query, l2Limit),
    ]);

    const layers: RecallLayer[] = [
      { order: 0, label: 'identity', records: [...identity, ...prefs] },
      { order: 1, label: 'facts', records: facts },
      { order: 2, label: 'relevant', records: relevant.records },
    ];
    const packed = packLayeredMemories(layers, budget);
    if (packed.selected.length === 0) return { ...EMPTY, backend: relevant.backend };

    // CTS-13 reinforcement — fire-and-forget, never awaited into the turn.
    void reinforceRecall(packed.selected);
    return { block: packed.block, memories: packed.selected, tokens: packed.tokens, backend: relevant.backend };
  } catch {
    return EMPTY;
  }
}

/** L2 — vector-relevant recall with an honest Cosmos keyword fallback. */
async function recallRelevant(
  scopeKeys: string[],
  query: string,
  topK: number,
): Promise<{ records: MemoryRecord[]; backend: 'vector' | 'keyword' | 'none' }> {
  if (!query.trim()) return { records: [], backend: 'none' };
  if (isMemoryVectorConfigured()) {
    const hits = await searchMemoryVector(query, scopeKeys, topK);
    if (hits && hits.length) {
      const ids = hits.map((h) => h.id);
      const records = await getByIds(scopeKeys, ids);
      // Preserve vector relevance order.
      const rank = new Map(ids.map((id, i) => [id, i]));
      records.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
      return { records, backend: 'vector' };
    }
    if (hits && hits.length === 0) return { records: [], backend: 'vector' };
  }
  const records = await keywordScan(scopeKeys, query, topK).catch(() => [] as MemoryRecord[]);
  return { records, backend: 'keyword' };
}

/** Map recalled memories into the CTS-04 `Citation` shape (memory-kind sources).
 *  Matches the transcript's `{ id, path, kind, heading?, preview }` contract. */
export function memoriesToCitations(
  memories: MemoryRecord[],
): Array<{ id: string; path: string; kind: string; heading: string; preview: string }> {
  return memories.map((m) => ({
    id: m.id,
    path: `memory/${m.scope}/${m.id}`,
    kind: 'memory',
    heading: `Memory · ${m.category}`,
    preview: m.content.slice(0, 160),
  }));
}
