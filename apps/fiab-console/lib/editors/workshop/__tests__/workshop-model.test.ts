import { describe, it, expect } from 'vitest';
import {
  nestedWidgetIds, isAdvancedKind, resolvePages, defaultPageId, pageIdForWidget, widgetsOnPage,
  evalVisibility, pivotShape, timelineShape,
  type WorkshopWidget, type WorkshopPage,
} from '../_workshop-model';

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

describe('isAdvancedKind (WS-4.5 widgets)', () => {
  it('recognizes the six B+ widgets', () => {
    for (const k of ['object-view', 'links', 'map', 'pivot', 'timeline', 'aip-copilot'] as const) {
      expect(isAdvancedKind(k)).toBe(true);
    }
  });
  it('rejects classic widgets', () => {
    for (const k of ['table', 'chart', 'metric', 'text', 'map-embed'] as const) {
      expect(isAdvancedKind(k)).toBe(false);
    }
  });
});

describe('resolvePages / defaultPageId / pageIdForWidget / widgetsOnPage', () => {
  it('seeds a default page when none persisted (back-compat)', () => {
    const pages = resolvePages(undefined);
    expect(pages).toHaveLength(1);
    expect(pages[0].kind).toBe('page');
    expect(defaultPageId(undefined)).toBe(pages[0].id);
  });
  it('seeds a home when only overlays exist', () => {
    const overlays: WorkshopPage[] = [{ id: 'ov1', name: 'Detail', kind: 'overlay', overlayStyle: 'drawer' }];
    const pages = resolvePages(overlays);
    expect(pages.some((p) => p.kind === 'page')).toBe(true);
    expect(pages.some((p) => p.id === 'ov1')).toBe(true);
  });
  it('keeps a widget on its own page and falls dangling/undefined pageIds back to the default', () => {
    const pages: WorkshopPage[] = [{ id: 'p1', name: 'Home', kind: 'page' }, { id: 'p2', name: 'Two', kind: 'page' }];
    expect(pageIdForWidget(w('a', 'table', { pageId: 'p2' }), pages)).toBe('p2');
    expect(pageIdForWidget(w('b', 'table', { pageId: 'ghost' }), pages)).toBe('p1');
    expect(pageIdForWidget(w('c', 'table'), pages)).toBe('p1');
  });
  it('widgetsOnPage groups undefined-pageId widgets onto the default page', () => {
    const pages: WorkshopPage[] = [{ id: 'p1', name: 'Home', kind: 'page' }, { id: 'p2', name: 'Two', kind: 'page' }];
    const widgets = [w('a', 'table', { pageId: 'p1' }), w('b', 'metric'), w('c', 'chart', { pageId: 'p2' })];
    expect(widgetsOnPage(widgets, 'p1', pages).map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(widgetsOnPage(widgets, 'p2', pages).map((x) => x.id)).toEqual(['c']);
  });
});

describe('evalVisibility (conditional visibility)', () => {
  it('undefined rule → always visible', () => {
    expect(evalVisibility(undefined, '')).toBe(true);
    expect(evalVisibility({ variableId: '', op: 'eq' }, 'x')).toBe(true);
  });
  it('eq / ne', () => {
    expect(evalVisibility({ variableId: 'v', op: 'eq', value: 'West' }, 'West')).toBe(true);
    expect(evalVisibility({ variableId: 'v', op: 'eq', value: 'West' }, 'East')).toBe(false);
    expect(evalVisibility({ variableId: 'v', op: 'ne', value: 'West' }, 'East')).toBe(true);
  });
  it('empty / notEmpty over scalars and object-set-filter arrays', () => {
    expect(evalVisibility({ variableId: 'v', op: 'empty' }, '')).toBe(true);
    expect(evalVisibility({ variableId: 'v', op: 'empty' }, [])).toBe(true);
    expect(evalVisibility({ variableId: 'v', op: 'notEmpty' }, 'x')).toBe(true);
    expect(evalVisibility({ variableId: 'v', op: 'notEmpty' }, [{ column: 'c', op: 'eq', value: '1' }])).toBe(true);
    expect(evalVisibility({ variableId: 'v', op: 'notEmpty' }, undefined)).toBe(false);
  });
  it('truthy / falsy coerce boolean-ish scalars', () => {
    expect(evalVisibility({ variableId: 'v', op: 'truthy' }, 'true')).toBe(true);
    expect(evalVisibility({ variableId: 'v', op: 'truthy' }, 'false')).toBe(false);
    expect(evalVisibility({ variableId: 'v', op: 'truthy' }, '0')).toBe(false);
    expect(evalVisibility({ variableId: 'v', op: 'falsy' }, '')).toBe(true);
    expect(evalVisibility({ variableId: 'v', op: 'falsy' }, 'yes')).toBe(false);
  });
});

describe('pivotShape', () => {
  const columns = ['region', 'quarter', 'amount'];
  const rows: unknown[][] = [
    ['West', 'Q1', 10], ['West', 'Q1', 5], ['West', 'Q2', 20],
    ['East', 'Q1', 7], ['East', 'Q2', 3],
  ];
  it('sums a measure across a row × col matrix', () => {
    const p = pivotShape(columns, rows, 'region', 'quarter', 'sum', 'amount');
    expect(p.rowKeys).toEqual(['East', 'West']);
    expect(p.colKeys).toEqual(['Q1', 'Q2']);
    expect(p.cells['West']['Q1']).toBe(15);
    expect(p.cells['West']['Q2']).toBe(20);
    expect(p.cells['East']['Q1']).toBe(7);
    expect(p.rowTotals['West']).toBe(35);
  });
  it('count ignores the measure column', () => {
    const p = pivotShape(columns, rows, 'region', 'quarter', 'count');
    expect(p.cells['West']['Q1']).toBe(2);
    expect(p.cells['East']['Q2']).toBe(1);
    expect(p.rowTotals['East']).toBe(2);
  });
  it('returns empty when the row/col field is missing', () => {
    expect(pivotShape(columns, rows, 'nope', 'quarter', 'count').rowKeys).toEqual([]);
  });
});

describe('timelineShape', () => {
  const columns = ['ts', 'event'];
  const rows: unknown[][] = [
    ['2026-03-02', 'Shipped'], ['2026-01-10', 'Created'], ['not-a-date', 'Ignored'], ['2026-02-15', 'Approved'],
  ];
  it('orders parseable rows ascending and drops undateable ones', () => {
    const t = timelineShape(columns, rows, 'ts', 'event');
    expect(t.map((e) => e.label)).toEqual(['Created', 'Approved', 'Shipped']);
    expect(t[0].ms).toBeLessThan(t[1].ms);
  });
  it('falls back to the first non-time column for the label', () => {
    const t = timelineShape(columns, [['2026-01-01', 'Only']], 'ts');
    expect(t[0].label).toBe('Only');
  });
  it('accepts epoch numbers and returns empty when the time column is absent', () => {
    expect(timelineShape(columns, [[1700000000000, 'x']], 'ts', 'event')).toHaveLength(1);
    expect(timelineShape(columns, rows, 'missing')).toEqual([]);
  });
});
