import { describe, it, expect } from 'vitest';
import { nestedWidgetIds, type WorkshopWidget } from '../_workshop-model';

const w = (id: string, kind: WorkshopWidget['kind'], extra: Partial<WorkshopWidget> = {}): WorkshopWidget => ({
  id, kind, title: id, ...extra,
});

describe('nestedWidgetIds', () => {
  it('returns empty set when no tabs widgets exist', () => {
    expect(nestedWidgetIds([w('a', 'table'), w('b', 'metric')]).size).toBe(0);
  });

  it('collects child ids across tabs and tab entries', () => {
    const ids = nestedWidgetIds([
      w('t1', 'tabs', { tabChildIds: [['a', 'b'], ['c']] }),
      w('a', 'table'), w('b', 'metric'), w('c', 'chart'),
    ]);
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores empty/self references and undefined per-tab arrays', () => {
    const ids = nestedWidgetIds([
      w('t1', 'tabs', { tabChildIds: [['', 't1'], undefined as unknown as string[], ['a']] }),
      w('a', 'text'),
    ]);
    expect([...ids]).toEqual(['a']);
  });

  it('never nests a tabs widget (cycle guard drops stale claims)', () => {
    const ids = nestedWidgetIds([
      w('t1', 'tabs', { tabChildIds: [['t2', 'a']] }),
      w('t2', 'tabs', { tabChildIds: [[]] }),
      w('a', 'gauge'),
    ]);
    expect(ids.has('t2')).toBe(false);
    expect(ids.has('a')).toBe(true);
  });

  it('non-tabs widgets with a stray tabChildIds field contribute nothing', () => {
    const ids = nestedWidgetIds([w('x', 'table', { tabChildIds: [['a']] }), w('a', 'text')]);
    expect(ids.size).toBe(0);
  });
});
