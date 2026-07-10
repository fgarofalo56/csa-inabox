/**
 * synapse-notebook-cell-adapter — unit contract for the mapping that lets the
 * Synapse editor render on the shared CodeCell / RichDisplay / MarkdownCell stack
 * (R4-SYN-1). Pure functions, no DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  toSharedCell, mergeSharedChange, buildRichFromTable,
  KIND_TO_LANG, LANG_TO_KIND, type EditorCell,
} from '../synapse-notebook-cell-adapter';

const base = (over: Partial<EditorCell> = {}): EditorCell => ({
  id: 'c1', type: 'code', lang: 'pyspark', source: 'print(1)', ...over,
});

describe('toSharedCell', () => {
  it('maps the Synapse CellKind to the shared NotebookCellLang', () => {
    expect(toSharedCell(base({ lang: 'sql' })).lang).toBe('sparksql');
    expect(toSharedCell(base({ lang: 'spark' })).lang).toBe('spark');
    expect(toSharedCell(base({ lang: 'csharp' })).lang).toBe('csharp');
    expect(toSharedCell(base({ lang: 'sparkr' })).lang).toBe('sparkr');
  });

  it('carries id / source / collapsed / locked / executionCount through', () => {
    const shared = toSharedCell(base({ collapsed: true, locked: true, executionCount: 3 }));
    expect(shared.id).toBe('c1');
    expect(shared.source).toBe('print(1)');
    expect(shared.collapsed).toBe(true);
    expect(shared.locked).toBe(true);
    expect(shared.executionCount).toBe(3);
  });

  it('surfaces ONLY an error on the shared cell (success stays off-cell)', () => {
    const ok = toSharedCell(base({ output: { status: 'ok', tableColumns: ['a'], tableRows: [['1']] } }));
    expect(ok.output).toBeUndefined();
    const running = toSharedCell(base({ output: { status: 'running', text: '…' } }));
    expect(running.output).toBeUndefined();
    const err = toSharedCell(base({ output: { status: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['t'] } }));
    expect(err.output).toEqual({ status: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['t'], textPlain: undefined });
  });

  it('drops lang on a markdown cell', () => {
    expect(toSharedCell(base({ type: 'markdown', lang: 'pyspark' })).lang).toBeUndefined();
  });
});

describe('mergeSharedChange', () => {
  it('maps only the changed keys back onto the EditorCell', () => {
    const prev = base();
    expect(mergeSharedChange(prev, { ...toSharedCell(prev), source: 'print(2)' })).toEqual({ source: 'print(2)' });
    expect(mergeSharedChange(prev, { ...toSharedCell(prev), collapsed: true })).toEqual({ collapsed: true });
    expect(mergeSharedChange(prev, { ...toSharedCell(prev), locked: true })).toEqual({ locked: true });
  });

  it('maps a shared language switch back to the Synapse CellKind', () => {
    const prev = base({ lang: 'pyspark' });
    expect(mergeSharedChange(prev, { ...toSharedCell(prev), lang: 'sparksql' })).toEqual({ lang: 'sql' });
    // python (shared) collapses onto pyspark (Synapse runs PySpark).
    expect(mergeSharedChange(prev, { ...toSharedCell(prev), lang: 'python' })).toEqual({});
  });

  it('clears output + executionCount when a Copilot Accept rewrites the source', () => {
    const prev = base({ output: { status: 'error', evalue: 'x' }, executionCount: 2 });
    const patch = mergeSharedChange(prev, { id: 'c1', type: 'code', source: 'fixed()', output: undefined });
    expect(patch).toEqual({ source: 'fixed()', output: undefined, executionCount: undefined });
  });
});

describe('KIND_TO_LANG / LANG_TO_KIND round-trip', () => {
  it('round-trips every Synapse kind', () => {
    (['pyspark', 'spark', 'sql', 'sparkr', 'csharp'] as const).forEach((k) => {
      expect(LANG_TO_KIND[KIND_TO_LANG[k]]).toBe(k);
    });
  });
});

describe('buildRichFromTable', () => {
  it('returns null when there is no table data', () => {
    expect(buildRichFromTable(undefined, undefined)).toBeNull();
    expect(buildRichFromTable(['a'], [])).toBeNull();
    expect(buildRichFromTable([], [['1']])).toBeNull();
  });

  it('builds a LoomDisplayPayload with inferred dtypes + chart recs', () => {
    const payload = buildRichFromTable(
      ['city', 'sales'],
      [['Paris', '10'], ['Rome', '20'], ['Paris', '30']],
    );
    expect(payload).not.toBeNull();
    expect(payload!.columns.map((c) => c.name)).toEqual(['city', 'sales']);
    // 'sales' is all-numeric → numeric dtype; 'city' → string.
    const sales = payload!.columns.find((c) => c.name === 'sales')!;
    expect(sales.dtype).toBe('double');
    expect(sales.mean).toBeDefined();
    const city = payload!.columns.find((c) => c.name === 'city')!;
    expect(city.cardinality).toBe(2);
    expect(payload!.rows.length).toBe(3);
    expect(payload!.totalCount).toBe(3);
    // A categorical × numeric frame yields at least one chart recommendation.
    expect(payload!.chartRecs.length).toBeGreaterThan(0);
    // dfVarName stays unset on the Synapse Livy path (full-agg is honestly gated).
    expect(payload!.dfVarName).toBeUndefined();
  });
});
