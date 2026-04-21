/**
 * useColumnSort — CSA-0124(5) column-sortable tables.
 *
 * Lightweight sorting hook for list/table pages. Returns the current sort
 * state plus a derived `sortedItems` array that is stable across renders
 * when inputs do not change. Click-toggle semantics:
 *
 *   - Clicking an unsorted column: sort ascending by that column.
 *   - Clicking the currently-asc column: flip to descending.
 *   - Clicking the currently-desc column: clear the sort.
 *
 * Accessibility:
 *   - Consumers apply `aria-sort` on the `<th>` based on `sortKey` / `sortDir`.
 *   - Header buttons should have an accessible label ("Sort by <column>").
 *
 * The hook is intentionally typed with generics and avoids `any`:
 *
 *   const { sortKey, sortDir, setSort, sortedItems } = useColumnSort(items, {
 *     getValue: (row, key) => row[key],
 *   });
 *
 * The caller owns the value-extraction strategy so the hook does not have
 * to know about nested fields (e.g. `source.owner.team`). The default
 * extractor reads `item[key]` for top-level keys, which covers the common
 * case without any bespoke wiring.
 */

import { useCallback, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

/** A value that can be compared — the three primitive shapes our lists use. */
type Comparable = string | number | boolean | Date | null | undefined;

export interface UseColumnSortOptions<T, K extends string = string> {
  /**
   * Strategy for pulling the comparable value for a row + column key.
   * Defaults to `(row, key) => (row as Record<string, unknown>)[key]`.
   */
  getValue?: (row: T, key: K) => Comparable;
  /** Optional initial sort — handy for defaulting e.g. to "updated_at desc". */
  initialKey?: K | null;
  initialDir?: SortDirection;
}

export interface UseColumnSortResult<T, K extends string = string> {
  sortKey: K | null;
  sortDir: SortDirection | null;
  /** Apply/toggle a sort by clicking the column header. */
  setSort: (key: K) => void;
  /** Derived, memoized sorted array. Never mutates `items`. */
  sortedItems: T[];
  /** Value for the `aria-sort` attribute on a header for `key`. */
  ariaSortFor: (key: K) => 'ascending' | 'descending' | 'none';
}

function defaultGetValue<T>(row: T, key: string): Comparable {
  const record = row as unknown as Record<string, unknown>;
  const raw = record[key];
  if (raw == null) return raw as null | undefined;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return raw;
  }
  if (raw instanceof Date) return raw;
  // Fallback: coerce to string for display-level comparability.
  return String(raw);
}

function compareValues(a: Comparable, b: Comparable): number {
  // Nullish always sorts last regardless of direction; the dir flip happens
  // in `sortedItems` below.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function useColumnSort<T, K extends string = string>(
  items: readonly T[] | undefined,
  options: UseColumnSortOptions<T, K> = {},
): UseColumnSortResult<T, K> {
  const { getValue, initialKey = null, initialDir = 'asc' } = options;

  const [sortKey, setSortKey] = useState<K | null>(initialKey);
  const [sortDir, setSortDir] = useState<SortDirection | null>(
    initialKey ? initialDir : null,
  );

  const setSort = useCallback(
    (key: K) => {
      setSortKey((prevKey) => {
        if (prevKey !== key) {
          setSortDir('asc');
          return key;
        }
        // Same column — cycle asc → desc → none.
        setSortDir((prevDir) => {
          if (prevDir === 'asc') return 'desc';
          if (prevDir === 'desc') {
            return null;
          }
          return 'asc';
        });
        return prevKey;
      });
    },
    [],
  );

  const sortedItems = useMemo(() => {
    const source = items ?? [];
    if (!sortKey || !sortDir) return [...source];
    const extractor = getValue ?? ((row: T, key: K) => defaultGetValue(row, key));
    const copy = [...source];
    copy.sort((a, b) => {
      const av = extractor(a, sortKey);
      const bv = extractor(b, sortKey);
      // Nullish values always sort last, regardless of direction —
      // operators expect "no value" rows to cluster at the bottom.
      const aNull = av == null;
      const bNull = bv == null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      const delta = compareValues(av, bv);
      return sortDir === 'asc' ? delta : -delta;
    });
    return copy;
  }, [items, sortKey, sortDir, getValue]);

  // After sortDir flips to null we also want sortKey to clear so the
  // header visually returns to the unsorted state.
  const effectiveKey = sortDir === null ? null : sortKey;

  const ariaSortFor = useCallback(
    (key: K): 'ascending' | 'descending' | 'none' => {
      if (effectiveKey !== key || !sortDir) return 'none';
      return sortDir === 'asc' ? 'ascending' : 'descending';
    },
    [effectiveKey, sortDir],
  );

  return {
    sortKey: effectiveKey,
    sortDir: effectiveKey ? sortDir : null,
    setSort,
    sortedItems,
    ariaSortFor,
  };
}

export default useColumnSort;
