/**
 * synapse-notebook-cell-adapter — unit contract for the mapping that lets the
 * Synapse editor render on the shared CodeCell / RichDisplay / MarkdownCell stack
 * (R4-SYN-1). Pure functions, no DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  toSharedCell, mergeSharedChange, buildRichFromTable,
  KIND_TO_LANG, LANG_TO_KIND, type EditorCell,
  parseRunReference, buildRunPreamble, clampProgress,
  metaToComments, commentsToMeta, applyMarkdownFormat, SPARK_SNIPPETS,
  type CellComment,
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

// ── R4-SYN-4 · %run ──────────────────────────────────────────────────────────
describe('parseRunReference', () => {
  it('extracts the referenced notebook basename from a leading %run', () => {
    expect(parseRunReference('%run MyHelpers')).toBe('MyHelpers');
    expect(parseRunReference('%run  folder/Shared  ')).toBe('Shared');
    expect(parseRunReference('%run "quoted path/Nb"')).toBe('Nb');
    expect(parseRunReference('%run ./Local')).toBe('Local');
    expect(parseRunReference('%run Params {"p": 1}')).toBe('Params');
  });
  it('is null when the first non-empty line is not %run', () => {
    expect(parseRunReference('df = spark.range(1)')).toBeNull();
    expect(parseRunReference('\n\n%%sql\nselect 1')).toBeNull();
    expect(parseRunReference('')).toBeNull();
  });
});

describe('buildRunPreamble', () => {
  const cell = (over: Partial<EditorCell>): EditorCell => ({ id: 'x', type: 'code', lang: 'pyspark', source: '', ...over });
  it('concatenates the referenced PySpark cells into a preamble', () => {
    const out = buildRunPreamble([
      cell({ source: 'def a():\n    return 1' }),
      cell({ type: 'markdown', source: '# doc' }),
      cell({ source: 'B = 2' }),
    ], 'Helpers');
    expect(out).toContain('def a():');
    expect(out).toContain('B = 2');
    expect(out).toContain('%run Helpers');
  });
  it('throws on a nested %run (non-recursive)', () => {
    expect(() => buildRunPreamble([cell({ source: '%run Other' })], 'Helpers')).toThrow(/non-recursive/i);
  });
  it('throws when the referenced notebook has no PySpark code', () => {
    expect(() => buildRunPreamble([cell({ type: 'markdown', source: '# only docs' })], 'Helpers')).toThrow(/no PySpark/i);
    expect(() => buildRunPreamble([cell({ lang: 'sql', source: 'select 1' })], 'Helpers')).toThrow(/no PySpark/i);
  });
});

// ── R4-SYN-5 · progress ──────────────────────────────────────────────────────
describe('clampProgress', () => {
  it('maps a 0..1 fraction to an integer 0..100 percentage', () => {
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(0.5)).toBe(50);
    expect(clampProgress(1)).toBe(100);
    expect(clampProgress(1.5)).toBe(100);
    expect(clampProgress(-0.2)).toBe(0);
    expect(clampProgress(undefined)).toBe(0);
    expect(clampProgress(NaN)).toBe(0);
  });
});

// ── R4-SYN-9 · comment metadata round-trip ───────────────────────────────────
describe('comment IPYNB round-trip', () => {
  it('reads a valid comment array and drops malformed entries', () => {
    const parsed = metaToComments({ loomComments: [
      { id: 'c1', author: 'You', text: 'hi', at: '2026-07-10T00:00:00Z', resolved: true },
      { author: 'x' }, // no text → dropped
    ] });
    expect(parsed).toHaveLength(1);
    expect(parsed![0]).toMatchObject({ id: 'c1', text: 'hi', resolved: true });
  });
  it('returns undefined for no comments', () => {
    expect(metaToComments({})).toBeUndefined();
    expect(metaToComments({ loomComments: [] })).toBeUndefined();
    expect(commentsToMeta(undefined)).toBeUndefined();
    expect(commentsToMeta([])).toBeUndefined();
  });
  it('serializes a non-empty comment list', () => {
    const list: CellComment[] = [{ id: 'c', author: 'You', text: 't', at: 'now' }];
    expect(commentsToMeta(list)).toBe(list);
  });
});

// ── R4-SYN-11 · markdown format transforms + snippet catalog ──────────────────
describe('applyMarkdownFormat', () => {
  it('wraps a selection with bold / italic / inline code', () => {
    expect(applyMarkdownFormat('hello', 0, 5, 'bold').source).toBe('**hello**');
    expect(applyMarkdownFormat('hi', 0, 2, 'italic').source).toBe('_hi_');
    expect(applyMarkdownFormat('x', 0, 1, 'code').source).toBe('`x`');
  });
  it('fences a multiline code selection', () => {
    expect(applyMarkdownFormat('a\nb', 0, 3, 'code').source).toBe('```\na\nb\n```');
  });
  it('prefixes lines for headings, lists, and quotes', () => {
    expect(applyMarkdownFormat('Title', 0, 5, 'h1').source).toBe('# Title');
    expect(applyMarkdownFormat('Sub', 0, 3, 'h2').source).toBe('## Sub');
    expect(applyMarkdownFormat('a\nb', 0, 3, 'ul').source).toBe('- a\n- b');
    expect(applyMarkdownFormat('a\nb', 0, 3, 'ol').source).toBe('1. a\n2. b');
    expect(applyMarkdownFormat('q', 0, 1, 'quote').source).toBe('> q');
  });
  it('builds a link with the selection as label', () => {
    expect(applyMarkdownFormat('site', 0, 4, 'link').source).toBe('[site](https://)');
  });
  it('uses a placeholder when nothing is selected', () => {
    expect(applyMarkdownFormat('', 0, 0, 'bold').source).toBe('**text**');
  });
});

describe('SPARK_SNIPPETS', () => {
  it('exposes a cross-language temp-view helper (B15) among the snippets', () => {
    const tv = SPARK_SNIPPETS.find((s) => s.id === 'temp-view');
    expect(tv).toBeDefined();
    expect(tv!.source).toContain('createOrReplaceTempView');
    // every snippet carries a runnable source + a valid Synapse cell language.
    for (const s of SPARK_SNIPPETS) {
      expect(s.source.trim().length).toBeGreaterThan(0);
      expect(['pyspark', 'spark', 'sql', 'sparkr', 'csharp']).toContain(s.lang);
    }
  });
});
