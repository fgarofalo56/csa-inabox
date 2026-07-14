import { describe, it, expect } from 'vitest';
import { packLayeredMemories, estimateMemoryTokens, type RecallLayer } from '../memory-recall-core';
import type { MemoryRecord } from '../memory-types';

function mem(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, scopeKey: 'user:o', scope: 'user', content, category: 'fact', confidence: 0.8,
    tags: [], createdAt: '2026-07-14T00:00:00.000Z', source: 'auto', ...over,
  };
}

describe('packLayeredMemories', () => {
  it('returns an empty pack when there are no memories', () => {
    const r = packLayeredMemories([{ order: 0, label: 'identity', records: [] }], 1000);
    expect(r.selected).toHaveLength(0);
    expect(r.block).toBe('');
    expect(r.tokens).toBe(0);
  });

  it('packs higher-priority (lower order) layers first', () => {
    const layers: RecallLayer[] = [
      { order: 2, label: 'relevant', records: [mem('r1', 'relevant fact')] },
      { order: 0, label: 'identity', records: [mem('i1', 'identity fact')] },
    ];
    const r = packLayeredMemories(layers, 1000);
    expect(r.selected[0].id).toBe('i1'); // order 0 before order 2
    expect(r.selected.map((m) => m.id)).toContain('r1');
  });

  it('dedupes the same memory id across layers', () => {
    const shared = mem('dup', 'shared');
    const layers: RecallLayer[] = [
      { order: 0, label: 'identity', records: [shared] },
      { order: 2, label: 'relevant', records: [shared] },
    ];
    const r = packLayeredMemories(layers, 1000);
    expect(r.selected.filter((m) => m.id === 'dup')).toHaveLength(1);
  });

  it('within a layer, higher confidence packs first', () => {
    const layers: RecallLayer[] = [
      { order: 1, label: 'facts', records: [mem('lo', 'low', { confidence: 0.5 }), mem('hi', 'high', { confidence: 0.95 })] },
    ];
    const r = packLayeredMemories(layers, 1000);
    expect(r.selected[0].id).toBe('hi');
  });

  it('respects the token budget and stops adding once full', () => {
    const many = Array.from({ length: 50 }, (_, i) => mem(`m${i}`, `fact number ${i} with some words to consume tokens`));
    const layers: RecallLayer[] = [{ order: 0, label: 'facts', records: many }];
    const small = packLayeredMemories(layers, 60);
    const large = packLayeredMemories(layers, 100000);
    expect(small.selected.length).toBeLessThan(large.selected.length);
    expect(small.tokens).toBeLessThanOrEqual(60);
  });

  it('produces a header + one bullet per selected memory', () => {
    const r = packLayeredMemories([{ order: 0, label: 'identity', records: [mem('a', 'alpha'), mem('b', 'beta')] }], 1000);
    expect(r.block).toContain('Long-term memory');
    expect(r.block).toContain('alpha');
    expect(r.block).toContain('beta');
    expect(r.tokens).toBe(estimateMemoryTokens(r.block));
  });
});
