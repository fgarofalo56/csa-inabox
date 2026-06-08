/**
 * Shared client-side result export utilities — CSV / JSON serializers
 * and a blob download trigger. Used by every SQL editor that renders a
 * QueryResponse grid (Synapse Dedicated + Serverless, Databricks SQL
 * Warehouse, Fabric/Synapse Warehouse).
 *
 * Pure TypeScript — no React, no Fluent UI — so the serializers are unit
 * testable in plain Node. The download trigger touches `document` and is
 * only ever called from a browser ('use client') context.
 *
 * Data in == data out: rows are serialized exactly as the BFF returned them
 * from the real TDS / Databricks Statement Execution response. No mock data.
 */

/** Trigger a client-side download of an in-memory string blob. */
export function downloadBlob(filename: string, mime: string, data: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** RFC-4180 field escaping — quote fields containing comma/quote/newline. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Serialize a column/row result set to CSV (CRLF line endings, header row). */
export function resultsToCsv(columns: string[], rows: unknown[][]): string {
  return [
    columns.map(csvEscape).join(','),
    ...rows.map((r) => columns.map((_, j) => csvEscape(r[j])).join(',')),
  ].join('\r\n');
}

/** Serialize a column/row result set to a pretty JSON array of row objects. */
export function resultsToJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j] ?? null]))),
    null,
    2,
  );
}

/** Convenience: serialize to CSV and trigger a `<basename>.csv` download. */
export function downloadResultsCsv(basename: string, columns: string[], rows: unknown[][]): void {
  downloadBlob(`${basename}.csv`, 'text/csv', resultsToCsv(columns, rows));
}

/** Convenience: serialize to JSON and trigger a `<basename>.json` download. */
export function downloadResultsJson(basename: string, columns: string[], rows: unknown[][]): void {
  downloadBlob(`${basename}.json`, 'application/json', resultsToJson(columns, rows));
}
