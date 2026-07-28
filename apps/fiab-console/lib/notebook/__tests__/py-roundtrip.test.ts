/**
 * N19a — percent-format `.py` round trip.
 *
 * The acceptance contract: export → import must preserve every cell, its type,
 * its language and its source verbatim (modulo leading/trailing blank lines,
 * which the format cannot carry). A silent cell loss here would delete a user's
 * work on a git round trip.
 */

import { describe, it, expect } from 'vitest';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { cellsToPercentPy, percentPyToCells, percentPyFilename, percentPyConflicts } from '../py-roundtrip';

function code(id: string, source: string, lang: NotebookCellLang = 'pyspark'): NotebookCell {
  return { id, type: 'code', lang, source };
}
function md(id: string, source: string): NotebookCell {
  return { id, type: 'markdown', source };
}

const NOTEBOOK: NotebookCell[] = [
  md('m1', '# Sales analysis\n\nLoads the bronze table and aggregates it.'),
  code('c1', 'path = "/data/sales"\ndf = spark.read.parquet(path)'),
  code('c2', 'SELECT country, sum(amount) FROM sales GROUP BY country', 'sparksql'),
  code('c3', 'val ds = spark.table("sales")', 'spark'),
  code('c4', 'summary(df)', 'sparkr'),
  code('c5', 'import pandas as pd\npdf = pd.DataFrame()', 'python'),
];

describe('cellsToPercentPy', () => {
  it('writes a percent header and one marker per cell', () => {
    const text = cellsToPercentPy(NOTEBOOK, 'pyspark', 'Sales');
    expect(text).toContain('# format: percent');
    expect(text).toContain('# default_lang: pyspark');
    expect(text).toContain('# %% [markdown]');
    expect(text).toContain('# %% [sql]');
    expect(text).toContain('# %% [scala]');
    expect(text).toContain('# %% [r]');
    expect(text).toContain('# %% [python]');
    // Every code cell is tagged — including the notebook default — so the
    // reader never has to guess a language.
    expect(text).toContain('# %% [pyspark]');
  });

  it('comment-prefixes markdown bodies (including blank lines)', () => {
    const text = cellsToPercentPy([md('m', 'line one\n\nline two')], 'pyspark');
    expect(text).toContain('# line one\n#\n# line two');
  });

  it('produces a non-empty file for an empty notebook', () => {
    expect(cellsToPercentPy([], 'pyspark')).toContain('# %%');
  });
});

describe('round trip: cells → .py → cells', () => {
  const text = cellsToPercentPy(NOTEBOOK, 'pyspark', 'Sales');
  const parsed = percentPyToCells(text);

  it('preserves the cell count — no cell is dropped or invented', () => {
    expect(parsed.cells).toHaveLength(NOTEBOOK.length);
  });

  it('preserves cell types in order', () => {
    expect(parsed.cells.map((c) => c.type)).toEqual(NOTEBOOK.map((c) => c.type));
  });

  it('preserves per-cell language', () => {
    expect(parsed.cells.map((c) => c.lang)).toEqual(NOTEBOOK.map((c) => c.lang));
  });

  it('preserves source text verbatim', () => {
    expect(parsed.cells.map((c) => c.source)).toEqual(NOTEBOOK.map((c) => c.source));
  });

  it('preserves the notebook default language', () => {
    expect(parsed.defaultLang).toBe('pyspark');
  });

  it('drops the front-matter header instead of turning it into a cell', () => {
    expect(parsed.cells[0].type).toBe('markdown');
    expect(parsed.cells[0].source).not.toContain('format: percent');
  });

  it('is stable across a second round trip', () => {
    const again = percentPyToCells(cellsToPercentPy(parsed.cells, parsed.defaultLang));
    expect(again.cells.map((c) => [c.type, c.lang, c.source]))
      .toEqual(parsed.cells.map((c) => [c.type, c.lang, c.source]));
  });

  it('round-trips a python-default notebook', () => {
    const cells = [code('a', 'x = 1', 'python'), code('b', 'SELECT 1', 'sparksql')];
    const out = percentPyToCells(cellsToPercentPy(cells, 'python'));
    expect(out.defaultLang).toBe('python');
    expect(out.cells.map((c) => c.lang)).toEqual(['python', 'sparksql']);
  });

  it('round-trips a markdown heading without eating the "#"', () => {
    const out = percentPyToCells(cellsToPercentPy([md('m', '## Heading\ntext')], 'pyspark'));
    expect(out.cells[0].source).toBe('## Heading\ntext');
  });
});

describe('percentPyConflicts', () => {
  it('flags a cell whose body would be misread as a separator', () => {
    expect(percentPyConflicts([code('a', 'x = 1\n# %% not a marker')]))
      .toEqual([{ cellId: 'a', line: '# %% not a marker' }]);
  });

  it('returns nothing for ordinary cells', () => {
    expect(percentPyConflicts(NOTEBOOK)).toEqual([]);
  });
});

describe('percentPyFilename', () => {
  it('sanitizes the display name', () => {
    expect(percentPyFilename('Sales / Q3 analysis')).toBe('Sales-Q3-analysis.py');
    expect(percentPyFilename(undefined)).toBe('notebook.py');
    expect(percentPyFilename('!!!')).toBe('notebook.py');
  });
});
