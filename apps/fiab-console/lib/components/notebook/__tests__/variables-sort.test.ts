import { describe, it, expect } from 'vitest';
import { sortVarRows, type VarRow } from '../variables-sort';

const rows: VarRow[] = [
  { name: 'x', type: 'list', len: 3, repr: '[1, 2, 3]' },
  { name: 'df', type: 'DataFrame', len: 100, repr: '<DataFrame>' },
  { name: 'count', type: 'int', len: null, repr: '42' },
  { name: 'Apple', type: 'str', len: 5, repr: "'Apple'" },
];

describe('sortVarRows', () => {
  it('sorts by name ascending, case-insensitively', () => {
    const out = sortVarRows(rows, 'name', 'asc').map(r => r.name);
    expect(out).toEqual(['Apple', 'count', 'df', 'x']);
  });

  it('sorts by name descending', () => {
    const out = sortVarRows(rows, 'name', 'desc').map(r => r.name);
    expect(out).toEqual(['x', 'df', 'count', 'Apple']);
  });

  it('sorts by type', () => {
    const out = sortVarRows(rows, 'type', 'asc').map(r => r.type);
    expect(out).toEqual(['DataFrame', 'int', 'list', 'str']);
  });

  it('sorts by length ascending with null lengths last', () => {
    const out = sortVarRows(rows, 'len', 'asc').map(r => r.name);
    // 3 (x), 5 (Apple), 100 (df), then null (count) last
    expect(out).toEqual(['x', 'Apple', 'df', 'count']);
  });

  it('keeps null lengths last even when sorting descending', () => {
    const out = sortVarRows(rows, 'len', 'desc').map(r => r.name);
    // 100 (df), 5 (Apple), 3 (x), then null (count) still last
    expect(out).toEqual(['df', 'Apple', 'x', 'count']);
  });

  it('does not mutate the input array', () => {
    const before = rows.map(r => r.name);
    sortVarRows(rows, 'name', 'asc');
    expect(rows.map(r => r.name)).toEqual(before);
  });

  it('finds the acceptance row x | list | 3 | [1, 2, 3]', () => {
    const x = rows.find(r => r.name === 'x')!;
    expect(x.type).toBe('list');
    expect(x.len).toBe(3);
    expect(x.repr).toBe('[1, 2, 3]');
  });
});
