/**
 * Unit tests for the R4-NB parity helper functions (pure, no React render):
 *   - parseParameterCell  (R4-NB-2 papermill parameter parsing)
 *   - buildOutline        (R4-NB-6 markdown-heading outline)
 */
import { describe, it, expect } from 'vitest';
import { parseParameterCell } from '../parameters-dialog';
import { buildOutline } from '../outline-pane';
import type { NotebookCell } from '@/lib/types/notebook-cell';

describe('parseParameterCell (R4-NB-2)', () => {
  it('parses simple name = value assignments, keeping the raw RHS', () => {
    const decls = parseParameterCell('n = 10\nlabel = "prod"\nratio = 0.5');
    expect(decls).toEqual([
      { name: 'n', defaultValue: '10' },
      { name: 'label', defaultValue: '"prod"' },
      { name: 'ratio', defaultValue: '0.5' },
    ]);
  });

  it('skips comments, blanks, and non-assignment statements', () => {
    const decls = parseParameterCell('# a comment\n\nimport os\nfor x in range(3):\n    pass\nkeep = 1');
    expect(decls).toEqual([{ name: 'keep', defaultValue: '1' }]);
  });

  it('strips a trailing inline comment from the value', () => {
    const decls = parseParameterCell('threshold = 42  # tune me');
    expect(decls).toEqual([{ name: 'threshold', defaultValue: '42' }]);
  });

  it('supports a type-annotated assignment', () => {
    const decls = parseParameterCell('count: int = 5');
    expect(decls).toEqual([{ name: 'count', defaultValue: '5' }]);
  });
});

describe('buildOutline (R4-NB-6)', () => {
  const cell = (id: string, type: 'code' | 'markdown', source: string): NotebookCell =>
    ({ id, type, source, lang: type === 'code' ? 'pyspark' : undefined });

  it('extracts markdown headings with their levels, in order', () => {
    const outline = buildOutline([
      cell('m1', 'markdown', '# Title\nsome text\n## Section A'),
      cell('c1', 'code', 'df = spark.range(10)'),
      cell('m2', 'markdown', '### Sub B'),
    ]);
    expect(outline).toEqual([
      { cellId: 'm1', level: 1, text: 'Title' },
      { cellId: 'm1', level: 2, text: 'Section A' },
      { cellId: 'm2', level: 3, text: 'Sub B' },
    ]);
  });

  it('ignores code cells and non-heading markdown lines', () => {
    const outline = buildOutline([
      cell('c1', 'code', '# this is a python comment, not a heading'),
      cell('m1', 'markdown', 'plain paragraph text'),
    ]);
    expect(outline).toEqual([]);
  });
});
