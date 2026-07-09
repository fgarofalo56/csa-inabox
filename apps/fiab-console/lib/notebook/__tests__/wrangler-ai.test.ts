/**
 * Unit tests for the Data Wrangler AI-assist pure logic (FGC-16):
 * rule-based suggestion generation from column profiles, AOAI-proposed-step
 * validation against the closed gallery, and the profiling helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRuleSuggestions,
  validateWranglerSteps,
  isNumericDtype,
  looksNumeric,
  hasLeadingTrailingWhitespace,
  duplicateRowCount,
  dedupeSuggestions,
  operationCatalogSpec,
  type ColSummary,
} from '@/lib/notebook/wrangler-ai';

describe('profiling helpers', () => {
  it('isNumericDtype recognizes pandas numeric dtypes', () => {
    expect(isNumericDtype('int64')).toBe(true);
    expect(isNumericDtype('float32')).toBe(true);
    expect(isNumericDtype('Int64')).toBe(true);
    expect(isNumericDtype('object')).toBe(false);
    expect(isNumericDtype('bool')).toBe(false);
    expect(isNumericDtype(undefined)).toBe(false);
  });

  it('looksNumeric only when there is a string that parses as a number', () => {
    expect(looksNumeric(['1', '2', '3'])).toBe(true);
    expect(looksNumeric(['1.5', null, '2'])).toBe(true);
    expect(looksNumeric(['abc', '2'])).toBe(false);
    expect(looksNumeric([1, 2, 3])).toBe(false); // no strings to reinterpret
    expect(looksNumeric([null, '', undefined])).toBe(false);
  });

  it('hasLeadingTrailingWhitespace detects untrimmed strings', () => {
    expect(hasLeadingTrailingWhitespace([' a', 'b'])).toBe(true);
    expect(hasLeadingTrailingWhitespace(['a ', 'b'])).toBe(true);
    expect(hasLeadingTrailingWhitespace(['a', 'b'])).toBe(false);
    expect(hasLeadingTrailingWhitespace([1, 2])).toBe(false);
  });

  it('duplicateRowCount counts exact repeats', () => {
    expect(duplicateRowCount([{ a: 1 }, { a: 1 }, { a: 2 }])).toBe(1);
    expect(duplicateRowCount([{ a: 1 }, { a: 2 }])).toBe(0);
  });
});

describe('buildRuleSuggestions', () => {
  const rows = [
    { Name: 'Alice ', Age: '29', City: 'Paris', Const: 'x' },
    { Name: 'Bob', Age: '', City: 'Madrid', Const: 'x' },
    { Name: 'Cara', Age: '41', City: 'Paris', Const: 'x' },
  ];

  it('fills a low-missing NUMERIC column with the median', () => {
    const summary: ColSummary[] = [{ name: 'Age', dtype: 'int64', missing: 1, unique: 2 }];
    const s = buildRuleSuggestions(summary, rows, 3);
    const fill = s.find((x) => x.step.op === 'fill_missing');
    expect(fill).toBeTruthy();
    expect(fill!.step.strategy).toBe('median');
    expect(fill!.category).toBe('Missing');
  });

  it('fills a low-missing object column with the mode (median would break)', () => {
    const summary: ColSummary[] = [{ name: 'Age', dtype: 'object', missing: 1, unique: 2 }];
    const s = buildRuleSuggestions(summary, rows, 3);
    const fill = s.find((x) => x.step.op === 'fill_missing');
    expect(fill!.step.strategy).toBe('mode');
  });

  it('suggests dropping rows when a column is mostly missing', () => {
    const summary: ColSummary[] = [{ name: 'Age', dtype: 'float64', missing: 2, unique: 1 }];
    const s = buildRuleSuggestions(summary, rows, 3);
    expect(s.some((x) => x.step.op === 'drop_missing')).toBe(true);
    expect(s.some((x) => x.step.op === 'fill_missing')).toBe(false);
  });

  it('suggests a cast for a numeric-looking object column', () => {
    const summary: ColSummary[] = [{ name: 'Age', dtype: 'object', missing: 0, unique: 3 }];
    const s = buildRuleSuggestions(summary, [{ Age: '10' }, { Age: '20' }], 2);
    const cast = s.find((x) => x.step.op === 'cast_type');
    expect(cast).toBeTruthy();
    expect(cast!.step.column).toBe('Age');
    expect(cast!.step.dtype).toBe('int');
  });

  it('suggests trimming whitespace and dropping a constant column', () => {
    const summary: ColSummary[] = [
      { name: 'Name', dtype: 'object', missing: 0, unique: 3 },
      { name: 'Const', dtype: 'object', missing: 0, unique: 1 },
    ];
    const s = buildRuleSuggestions(summary, rows, 3);
    expect(s.some((x) => x.step.op === 'strip_whitespace' && x.step.column === 'Name')).toBe(true);
    expect(s.some((x) => x.step.op === 'drop_columns')).toBe(true);
  });

  it('suggests dedupe when the sample has duplicate rows', () => {
    const dupRows = [{ a: 1 }, { a: 1 }];
    const s = buildRuleSuggestions([], dupRows, 2);
    expect(s.some((x) => x.step.op === 'drop_duplicates')).toBe(true);
  });

  it('returns nothing for a clean profile', () => {
    const summary: ColSummary[] = [{ name: 'Age', dtype: 'int64', missing: 0, unique: 3 }];
    const s = buildRuleSuggestions(summary, [{ Age: 1 }, { Age: 2 }, { Age: 3 }], 3);
    expect(s).toEqual([]);
  });
});

describe('validateWranglerSteps', () => {
  const columns = ['Name', 'Age', 'City'];

  it('accepts a valid step and strips stray keys', () => {
    const { valid, rejected } = validateWranglerSteps(
      [{ op: 'drop_columns', columns: ['Age'], bogus: 1 }],
      columns,
    );
    expect(rejected).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toEqual({ op: 'drop_columns', columns: ['Age'] });
    expect((valid[0] as any).bogus).toBeUndefined();
  });

  it('rejects an unknown operation', () => {
    const { valid, rejected } = validateWranglerSteps([{ op: 'delete_everything' }], columns);
    expect(valid).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/unknown operation/);
  });

  it('rejects a step referencing a non-existent column', () => {
    const { valid, rejected } = validateWranglerSteps(
      [{ op: 'strip_whitespace', column: 'Nope' }],
      columns,
    );
    expect(valid).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/does not exist/);
  });

  it('rejects a bad columns-array entry', () => {
    const { rejected } = validateWranglerSteps([{ op: 'drop_columns', columns: ['Age', 'Ghost'] }], columns);
    expect(rejected[0].reason).toMatch(/Ghost/);
  });

  it('rejects an invalid select option', () => {
    const { rejected } = validateWranglerSteps(
      [{ op: 'change_case', column: 'Name', mode: 'sideways' }],
      columns,
    );
    expect(rejected[0].reason).toMatch(/not a valid mode/);
  });

  it('handles non-array / non-object input safely', () => {
    expect(validateWranglerSteps(null, columns)).toEqual({ valid: [], rejected: [] });
    const { rejected } = validateWranglerSteps(['nope'], columns);
    expect(rejected[0].reason).toBe('not an object');
  });
});

describe('dedupeSuggestions + operationCatalogSpec', () => {
  it('dedupes by id keeping the first', () => {
    const a = { id: 'x', title: 'A', rationale: '', category: 'Schema' as const, step: { op: 'sort' }, source: 'rule' as const };
    const b = { ...a, title: 'B', source: 'ai' as const };
    const out = dedupeSuggestions([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('A');
  });

  it('operationCatalogSpec lists every gallery op with fields', () => {
    const spec = operationCatalogSpec();
    expect(spec).toMatch(/drop_columns/);
    expect(spec).toMatch(/fill_missing/);
    expect(spec).toMatch(/strategy:select=/);
  });
});
