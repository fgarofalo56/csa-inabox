/**
 * Tests for useColumnSort (CSA-0124(5)).
 */

import { renderHook, act } from '@testing-library/react';
import { useColumnSort } from '@/hooks/useColumnSort';

interface Row {
  name: string;
  count: number;
  updated_at?: string;
  nested?: { team: string };
}

const ROWS: Row[] = [
  { name: 'Bravo', count: 2, updated_at: '2025-02-01T00:00:00Z' },
  { name: 'alpha', count: 10, updated_at: '2025-06-15T00:00:00Z' },
  { name: 'Charlie', count: 5, updated_at: undefined },
  { name: 'delta', count: 1, updated_at: '2025-01-01T00:00:00Z' },
];

describe('useColumnSort', () => {
  it('returns items unmodified when no sort is active', () => {
    const { result } = renderHook(() => useColumnSort<Row>(ROWS));
    expect(result.current.sortKey).toBeNull();
    expect(result.current.sortDir).toBeNull();
    expect(result.current.sortedItems.map((r) => r.name)).toEqual([
      'Bravo', 'alpha', 'Charlie', 'delta',
    ]);
  });

  it('sorts ascending by the requested column on first click', () => {
    const { result } = renderHook(() => useColumnSort<Row>(ROWS));
    act(() => result.current.setSort('name'));
    expect(result.current.sortDir).toBe('asc');
    // localeCompare with sensitivity: 'base' treats a/A equal — alpha < Bravo < Charlie < delta
    expect(result.current.sortedItems.map((r) => r.name)).toEqual([
      'alpha', 'Bravo', 'Charlie', 'delta',
    ]);
  });

  it('toggles to descending on second click of the same column', () => {
    const { result } = renderHook(() => useColumnSort<Row>(ROWS));
    act(() => result.current.setSort('count'));
    act(() => result.current.setSort('count'));
    expect(result.current.sortDir).toBe('desc');
    expect(result.current.sortedItems.map((r) => r.count)).toEqual([10, 5, 2, 1]);
  });

  it('clears the sort on the third click of the same column', () => {
    const { result } = renderHook(() => useColumnSort<Row>(ROWS));
    act(() => result.current.setSort('count')); // asc
    act(() => result.current.setSort('count')); // desc
    act(() => result.current.setSort('count')); // cleared
    expect(result.current.sortKey).toBeNull();
    expect(result.current.sortDir).toBeNull();
    expect(result.current.sortedItems.map((r) => r.name)).toEqual([
      'Bravo', 'alpha', 'Charlie', 'delta',
    ]);
  });

  it('switching columns resets direction to asc', () => {
    const { result } = renderHook(() => useColumnSort<Row>(ROWS));
    act(() => result.current.setSort('count'));
    act(() => result.current.setSort('count')); // desc
    act(() => result.current.setSort('name'));
    expect(result.current.sortKey).toBe('name');
    expect(result.current.sortDir).toBe('asc');
  });

  it('places nullish values at the end regardless of direction', () => {
    const { result } = renderHook(() => useColumnSort<Row>(ROWS));
    act(() => result.current.setSort('updated_at'));
    // asc: 2025-01, 2025-02, 2025-06, undefined(Charlie)
    expect(result.current.sortedItems[3].name).toBe('Charlie');
    act(() => result.current.setSort('updated_at'));
    // desc still puts Charlie (undefined) last
    expect(result.current.sortedItems[3].name).toBe('Charlie');
  });

  it('uses a custom getValue for nested fields', () => {
    const rowsNested: Row[] = [
      { name: 'x', count: 0, nested: { team: 'Beta' } },
      { name: 'y', count: 0, nested: { team: 'Alpha' } },
      { name: 'z', count: 0, nested: { team: 'Gamma' } },
    ];
    const { result } = renderHook(() =>
      useColumnSort<Row>(rowsNested, {
        getValue: (row) => row.nested?.team,
      }),
    );
    act(() => result.current.setSort('team'));
    expect(result.current.sortedItems.map((r) => r.nested?.team)).toEqual([
      'Alpha', 'Beta', 'Gamma',
    ]);
  });

  it('respects an initial sort', () => {
    const { result } = renderHook(() =>
      useColumnSort<Row>(ROWS, { initialKey: 'count', initialDir: 'desc' }),
    );
    expect(result.current.sortKey).toBe('count');
    expect(result.current.sortDir).toBe('desc');
    expect(result.current.sortedItems.map((r) => r.count)).toEqual([10, 5, 2, 1]);
  });

  it('reports aria-sort for the active column', () => {
    const { result } = renderHook(() => useColumnSort<Row>(ROWS));
    act(() => result.current.setSort('name'));
    expect(result.current.ariaSortFor('name')).toBe('ascending');
    expect(result.current.ariaSortFor('count')).toBe('none');
    act(() => result.current.setSort('name'));
    expect(result.current.ariaSortFor('name')).toBe('descending');
  });

  it('tolerates undefined items list', () => {
    const { result } = renderHook(() => useColumnSort<Row>(undefined));
    expect(result.current.sortedItems).toEqual([]);
  });
});
