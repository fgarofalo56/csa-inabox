/**
 * Pure sort logic for the notebook Variable explorer, split out from
 * `variables-pane.tsx` so it can be unit-tested under vitest's node env
 * without pulling in Fluent UI / React render machinery.
 */

export interface VarRow {
  name: string;
  type: string;
  /** len(value) when the object is sized; null otherwise (e.g. an int). */
  len: number | null;
  /** repr(value), truncated server-side. */
  repr: string;
}

export type VarSortCol = 'name' | 'type' | 'len';
export type VarSortDir = 'asc' | 'desc';

/**
 * Sort rows for the variable table. null lengths always sort last (Synapse
 * Studio shows unsized objects at the bottom of a length sort). Name/Type sort
 * case-insensitively with numeric awareness, matching the portal's behaviour.
 */
export function sortVarRows(rows: VarRow[], col: VarSortCol, dir: VarSortDir): VarRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (col === 'len') {
      const av = a.len, bv = b.len;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls last, regardless of direction
      if (bv == null) return -1;
      return (av - bv) * sign;
    }
    return a[col].localeCompare(b[col], undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}
