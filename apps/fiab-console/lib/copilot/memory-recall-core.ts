/**
 * Pure layered-recall packing for the memory brain (CTS-08) — no Cosmos / AI
 * Search imports, so the L0→L2 budget packing is unit-testable in isolation. The
 * Azure adapter (lib/azure/memory-recall.ts) fetches the candidate layers and
 * calls {@link packLayeredMemories} to select + render within a token budget.
 */

import type { MemoryRecord } from './memory-types';

/** A candidate layer with its recall priority. Lower `order` packs first. */
export interface RecallLayer {
  /** L0 identity/prefs = 0, L1 high-confidence facts = 1, L2 vector-relevant = 2. */
  order: number;
  label: 'identity' | 'preferences' | 'facts' | 'relevant';
  records: MemoryRecord[];
}

export interface PackResult {
  /** The rendered system-message block ('' when nothing was selected). */
  block: string;
  /** The selected memories in packing order (deduped by id). */
  selected: MemoryRecord[];
  /** Total estimated tokens of the rendered block. */
  tokens: number;
}

/** Cheap token estimate (≈4 chars/token) — mirrors the orchestrator's estimator
 *  so the CTS-05 `memory` segment count matches what recall actually injected. */
export function estimateMemoryTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** Render one selected memory as a bullet the model can ground on. */
function renderMemory(m: MemoryRecord): string {
  const scope = m.scope === 'workspace' ? 'workspace' : 'you';
  return `- (${m.category}, about ${scope}) ${m.content}`;
}

/**
 * Greedily pack the layers under `tokenBudget`, highest priority first, deduping
 * by id across layers. Within a layer, higher confidence then more-recent packs
 * first. Returns the rendered block + the selected records (for CTS-04 memory
 * citations) + the block's token size (for the CTS-05 memory segment).
 */
export function packLayeredMemories(
  layers: RecallLayer[],
  tokenBudget: number,
  estimate: (t: string) => number = estimateMemoryTokens,
): PackResult {
  const budget = Math.max(0, Math.floor(tokenBudget) || 0);
  const header = 'Long-term memory — durable facts and preferences recalled about this user/workspace across past sessions. Use them when relevant; do not invent beyond them.';
  const headerTokens = estimate(header);
  if (budget <= headerTokens) return { block: '', selected: [], tokens: 0 };

  const ordered = [...layers].sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const selected: MemoryRecord[] = [];
  const lines: string[] = [];
  let used = headerTokens;

  for (const layer of ordered) {
    const sorted = [...layer.records].sort((a, b) => {
      const c = (b.confidence ?? 0) - (a.confidence ?? 0);
      if (c !== 0) return c;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    for (const m of sorted) {
      if (!m || !m.id || seen.has(m.id)) continue;
      const line = renderMemory(m);
      const lineTokens = estimate(line) + 1; // +1 for the newline join
      if (used + lineTokens > budget) continue; // try smaller subsequent items
      seen.add(m.id);
      selected.push(m);
      lines.push(line);
      used += lineTokens;
    }
  }

  if (selected.length === 0) return { block: '', selected: [], tokens: 0 };
  const block = `${header}\n${lines.join('\n')}`;
  return { block, selected, tokens: estimate(block) };
}
