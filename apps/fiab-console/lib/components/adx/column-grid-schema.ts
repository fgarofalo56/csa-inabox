/**
 * Pure (React-free) schema helpers for the Kusto table-schema designer.
 *
 * Kept separate from the `ColumnGridDesigner` component so they can be unit
 * tested without pulling in Fluent / React, and reused by any route or client
 * that needs to serialize / parse / validate a Kusto CSL schema string.
 *
 * Grounded in Microsoft Learn: Kusto "Scalar data types" + `.create table` /
 * `.alter-merge table` CSL schema syntax (`col:type, col:type`).
 */

/** The 10 Kusto scalar data types (Microsoft Learn: Scalar data types). */
export const KUSTO_TYPES = [
  'string', 'int', 'long', 'real', 'decimal',
  'datetime', 'bool', 'dynamic', 'guid', 'timespan',
] as const;

export type KustoScalarType = typeof KUSTO_TYPES[number];

export interface ColumnDef {
  name: string;
  type: KustoScalarType;
}

/** Serialize column defs to a Kusto CSL schema: `col:type, col:type`. */
export function toKustoSchema(cols: ColumnDef[]): string {
  return cols
    .map((c) => ({ name: c.name.trim(), type: c.type }))
    .filter((c) => c.name)
    .map((c) => `${c.name}:${c.type}`)
    .join(', ');
}

/** Parse `col:type, col:type` → ColumnDef[]. Tolerates whitespace; unknown
 *  types fall back to `string` so the grid always renders a valid Select. */
export function parseKustoSchema(raw: string): ColumnDef[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(',').flatMap((seg) => {
    const [n, t] = seg.split(':').map((x) => x.trim());
    if (!n || !t) return [];
    const type = (KUSTO_TYPES as readonly string[]).includes(t)
      ? (t as KustoScalarType) : 'string';
    return [{ name: n, type }];
  });
}

/** First validation problem with the column set, or null when valid. */
export function validateColumns(cols: ColumnDef[]): string | null {
  const named = cols.filter((c) => c.name.trim());
  if (named.length === 0) return 'Add at least one column.';
  for (const c of cols) {
    if (!c.name.trim()) return 'Every column needs a name.';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name.trim())) {
      return `"${c.name.trim()}" is not a valid column name (letters, digits, underscore; no leading digit).`;
    }
  }
  const lower = named.map((c) => c.name.trim().toLowerCase());
  const dup = lower.find((n, i) => lower.indexOf(n) !== i);
  if (dup) return `Duplicate column name "${dup}".`;
  return null;
}
