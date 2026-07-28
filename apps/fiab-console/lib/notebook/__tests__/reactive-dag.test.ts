/**
 * N19a — reactive notebook DAG + invalidation math.
 *
 * These tests are the correctness gate for the reactive runtime: if the
 * dependency analysis or the downstream closure is wrong, the editor either
 * re-runs cells it shouldn't (wasting a Spark session) or leaves stale results
 * on screen (a no-vaporware violation — the UI would be showing a number that
 * no longer follows from the code).
 */

import { describe, it, expect } from 'vitest';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import {
  analyzeSource,
  buildNotebookDag,
  downstreamOf,
  topoSort,
  staleAfterEdit,
  reactiveRunPlan,
  describeCellDeps,
  stripCommentsAndStrings,
  isAnalyzableLang,
} from '../reactive-dag';

function code(id: string, source: string, lang: NotebookCellLang = 'pyspark'): NotebookCell {
  return { id, type: 'code', lang, source };
}
function md(id: string, source = '# note'): NotebookCell {
  return { id, type: 'markdown', source };
}

describe('analyzeSource — definitions', () => {
  it('binds simple, annotated, augmented and tuple assignments', () => {
    const a = analyzeSource('x = 1\ny: int = 2\nx += 3\na, b = (1, 2)\n*rest, last = [1, 2, 3]');
    expect(a.defs).toEqual(['a', 'b', 'last', 'rest', 'x', 'y']);
  });

  it('binds imports, aliases and from-imports', () => {
    const a = analyzeSource('import os\nimport numpy as np\nimport a.b.c\nfrom pyspark.sql import functions as F, Window');
    expect(a.defs).toEqual(['F', 'Window', 'a', 'np', 'os']);
  });

  it('binds def / class / for / with-as / except-as / walrus', () => {
    const a = analyzeSource([
      'def build(x):',
      '    return x',
      'class Model:',
      '    pass',
      'for row in rows:',
      '    pass',
      'with open(p) as fh:',
      '    pass',
      'try:',
      '    pass',
      'except ValueError as err:',
      '    pass',
      'if (n := len(rows)) > 0:',
      '    pass',
    ].join('\n'));
    expect(a.defs).toEqual(['Model', 'build', 'err', 'fh', 'n', 'row']);
  });

  it('does NOT bind function-local names (indent > 0)', () => {
    const a = analyzeSource('def f():\n    local_only = 1\n    return local_only');
    expect(a.defs).toEqual(['f']);
    expect(a.uses).not.toContain('local_only');
  });

  it('does not treat attribute / subscript targets as new bindings', () => {
    const a = analyzeSource("cfg['k'] = 1\nobj.attr = 2");
    expect(a.defs).toEqual([]);
    expect(a.uses).toEqual(['cfg', 'obj']);
  });

  it('ignores names that only appear in comments or strings', () => {
    const a = analyzeSource('# ghost_name = 1\nreal = "another_ghost"\nprint(real)');
    expect(a.defs).toEqual(['real']);
    expect(a.uses).toEqual([]);
  });

  it('ignores keywords, builtins and injected session globals', () => {
    const a = analyzeSource('df = spark.read.parquet(path)\nprint(len(df))\ndisplay(df)');
    expect(a.defs).toEqual(['df']);
    expect(a.uses).toEqual(['path']);
  });

  it('treats magic lines as binding nothing', () => {
    const a = analyzeSource('%pip install pandas\n%%pyspark\ny = 1');
    expect(a.defs).toEqual(['y']);
  });

  it('returns nothing for non-Python cell languages (opaque nodes)', () => {
    expect(analyzeSource('SELECT a FROM t', 'sparksql')).toEqual({ defs: [], uses: [] });
    expect(analyzeSource('val x = 1', 'spark')).toEqual({ defs: [], uses: [] });
    expect(isAnalyzableLang('sparksql')).toBe(false);
    expect(isAnalyzableLang('python')).toBe(true);
    expect(isAnalyzableLang(undefined)).toBe(true); // defaults to pyspark
  });
});

describe('stripCommentsAndStrings', () => {
  it('blanks comment and string content but preserves line structure', () => {
    const out = stripCommentsAndStrings('a = "hello"  # trailing\nb = 2');
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toContain('hello');
    expect(out).not.toContain('trailing');
    expect(out).toContain('a =');
    expect(out).toContain('b = 2');
  });

  it('handles triple-quoted blocks spanning lines', () => {
    const out = stripCommentsAndStrings('doc = """line1\nsecret_name\n"""\nz = 1');
    expect(out).not.toContain('secret_name');
    expect(out).toContain('z = 1');
  });
});

describe('buildNotebookDag', () => {
  const cells = [
    code('c1', 'path = "/data/sales"'),
    code('c2', 'df = spark.read.parquet(path)'),
    md('m1'),
    code('c3', 'total = df.count()'),
    code('c4', 'other = 42'),
  ];

  it('includes only code cells, in document order', () => {
    const dag = buildNotebookDag(cells);
    expect(dag.order).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('links definer → user with the names carried on the edge', () => {
    const dag = buildNotebookDag(cells);
    expect(dag.edges).toEqual(expect.arrayContaining([
      { from: 'c1', to: 'c2', via: ['path'] },
      { from: 'c2', to: 'c3', via: ['df'] },
    ]));
    expect(dag.dependencies.c3).toEqual(['c2']);
    expect(dag.dependents.c1).toEqual(['c2']);
    expect(dag.dependents.c4).toEqual([]);
  });

  it('links backwards too — a cell may be defined below its user', () => {
    const dag = buildNotebookDag([
      code('u', 'print(later)'),
      code('d', 'later = 1'),
    ]);
    expect(dag.edges).toEqual([{ from: 'd', to: 'u', via: ['later'] }]);
    expect(topoSort(dag)).toEqual(['d', 'u']);
  });

  it('reports a name defined by more than one cell', () => {
    const dag = buildNotebookDag([code('a', 'x = 1'), code('b', 'x = 2'), code('c', 'print(x)')]);
    expect(dag.collisions).toEqual([{ name: 'x', cellIds: ['a', 'b'] }]);
    expect(dag.dependencies.c.sort()).toEqual(['a', 'b']);
  });

  it('detects a cycle and never leaves it in the run plan', () => {
    const dag = buildNotebookDag([
      code('a', 'x = y + 1'),
      code('b', 'y = x + 1'),
      code('z', 'standalone = 1'),
    ]);
    expect(dag.cycles).toHaveLength(1);
    expect(dag.cycles[0].sort()).toEqual(['a', 'b']);
    expect(downstreamOf(dag, ['a'])).toEqual([]);
  });

  it('is empty and safe for an empty / markdown-only notebook', () => {
    const dag = buildNotebookDag([md('m1'), md('m2')]);
    expect(dag.order).toEqual([]);
    expect(dag.edges).toEqual([]);
    expect(dag.cycles).toEqual([]);
    expect(downstreamOf(dag, ['nope'])).toEqual([]);
    expect(buildNotebookDag([]).order).toEqual([]);
  });
});

describe('downstreamOf — invalidation closure', () => {
  //  c1 → c2 → c3 → c4      c5 (independent)
  const dag = buildNotebookDag([
    code('c1', 'a = 1'),
    code('c2', 'b = a + 1'),
    code('c3', 'c = b + 1'),
    code('c4', 'd = c + 1'),
    code('c5', 'unrelated = 99'),
  ]);

  it('returns the transitive downstream, excluding the seed', () => {
    expect(downstreamOf(dag, ['c1'])).toEqual(['c2', 'c3', 'c4']);
    expect(downstreamOf(dag, ['c3'])).toEqual(['c4']);
  });

  it('returns nothing for a leaf or an independent cell', () => {
    expect(downstreamOf(dag, ['c4'])).toEqual([]);
    expect(downstreamOf(dag, ['c5'])).toEqual([]);
  });

  it('never invalidates upstream cells', () => {
    expect(downstreamOf(dag, ['c3'])).not.toContain('c2');
    expect(downstreamOf(dag, ['c3'])).not.toContain('c1');
  });

  it('unions multiple seeds without duplicates and stays topological', () => {
    expect(downstreamOf(dag, ['c1', 'c2'])).toEqual(['c3', 'c4']);
  });

  it('ignores ids that are not in the notebook', () => {
    expect(downstreamOf(dag, ['ghost'])).toEqual([]);
  });

  it('returns a diamond in dependency order', () => {
    //     top
    //    /   \
    //  left  right
    //    \   /
    //     join
    const diamond = buildNotebookDag([
      code('top', 'base = 1'),
      code('right', 'r = base * 3'),
      code('left', 'l = base * 2'),
      code('join', 'out = l + r'),
    ]);
    const plan = downstreamOf(diamond, ['top']);
    expect(plan).toHaveLength(3);
    expect(plan[plan.length - 1]).toBe('join');
    expect(plan.indexOf('left')).toBeLessThan(plan.indexOf('join'));
    expect(plan.indexOf('right')).toBeLessThan(plan.indexOf('join'));
  });
});

describe('topoSort', () => {
  it('falls back to document order when nothing depends on anything', () => {
    const dag = buildNotebookDag([code('a', 'x = 1'), code('b', 'y = 2'), code('c', 'z = 3')]);
    expect(topoSort(dag)).toEqual(['a', 'b', 'c']);
  });

  it('respects dependencies over document order', () => {
    const dag = buildNotebookDag([
      code('user', 'print(v)'),
      code('def1', 'v = 1'),
    ]);
    expect(topoSort(dag)).toEqual(['def1', 'user']);
  });

  it('appends cycle members last instead of dropping them', () => {
    const dag = buildNotebookDag([code('a', 'x = y'), code('b', 'y = x'), code('ok', 'q = 1')]);
    const order = topoSort(dag);
    expect(order).toHaveLength(3);
    expect(order[0]).toBe('ok');
    expect(order.slice(1).sort()).toEqual(['a', 'b']);
  });
});

describe('staleAfterEdit / reactiveRunPlan', () => {
  const dag = buildNotebookDag([
    code('c1', 'a = 1'),
    code('c2', 'b = a + 1'),
    code('c3', 'c = b + 1'),
    code('c4', 'solo = 0'),
  ]);

  it('marks the edited cell plus its downstream stale', () => {
    expect(staleAfterEdit(dag, ['c1'])).toEqual(['c1', 'c2', 'c3']);
  });

  it('merges with an already-stale set and de-duplicates', () => {
    expect(staleAfterEdit(dag, ['c2'], ['c4'])).toEqual(['c2', 'c3', 'c4']);
  });

  it('drops already-stale ids for cells that were deleted', () => {
    expect(staleAfterEdit(dag, ['c4'], ['deleted-cell'])).toEqual(['c4']);
  });

  it('run plan after a successful run excludes the ran cell and any exclusions', () => {
    expect(reactiveRunPlan(dag, 'c1')).toEqual(['c2', 'c3']);
    expect(reactiveRunPlan(dag, 'c1', ['c2'])).toEqual(['c3']);
    expect(reactiveRunPlan(dag, 'c4')).toEqual([]);
  });
});

describe('describeCellDeps', () => {
  const dag = buildNotebookDag([code('c1', 'a = 1'), code('c2', 'b = a + 1'), code('c3', 'solo = 1')]);

  it('summarizes upstream and downstream', () => {
    expect(describeCellDeps(dag, 'c2')).toContain('depends on 1 cell');
    expect(describeCellDeps(dag, 'c1')).toContain('1 cell depend');
    expect(describeCellDeps(dag, 'c3')).toContain('No detected dependencies');
  });
});
