/**
 * Pure, presentation-free helpers for the Lakehouse preview DataGrid. Kept out
 * of the 'use client' component so they can be unit-tested in a node env
 * (no Fluent / React imports). Covers CSV serialization, numeric-column
 * detection, and cell formatting used by sort/copy/filter.
 */

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

/** A column is numeric only if every non-null, non-empty cell parses finite. */
export function columnIsNumeric(rows: unknown[][], colIdx: number): boolean {
  let sawValue = false;
  for (const row of rows) {
    const v = row[colIdx];
    if (isNullish(v) || v === '') continue;
    sawValue = true;
    if (!Number.isFinite(Number(v))) return false;
  }
  return sawValue;
}

/** RFC-4180 quote a single CSV field. NULL/undefined become an empty field. */
export function csvField(v: unknown): string {
  if (isNullish(v)) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize columns + rows to RFC-4180 CSV (CRLF line endings, header row). */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) lines.push(columns.map((_, i) => csvField(row[i])).join(','));
  return lines.join('\r\n');
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Case-insensitive substring match across any cell — drives client filter. */
export function rowMatchesFilter(cells: unknown[], needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return cells.some((c) => formatCell(c).toLowerCase().includes(n));
}
