/**
 * Data profile for a Databricks command table result (R4-DBX-6).
 *
 * The Command Execution API returns a table result as `{ columns: string[],
 * rows: unknown[][] }` — no dtypes. This adapts that into the Livy
 * `application/json` split-orient shape ({schema:{fields}, data}) that the
 * shared, unit-tested `buildLoomDisplay` profiler consumes, inferring a numeric
 * vs string dtype per column by sampling values. The result is a
 * `LoomDisplayPayload` with real per-column stats (min/max/mean/stddev for
 * numeric columns; cardinality + top values for categorical) — the same profile
 * the Databricks notebook "Data Profile" output tab shows.
 */

import { buildLoomDisplay } from '@/lib/notebook/display-stats';
import type { LoomDisplayPayload } from '@/lib/types/notebook-cell';

function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim();
    return t !== '' && !Number.isNaN(Number(t));
  }
  return false;
}

/** Infer 'double' when every non-null sampled value parses as a number, else 'string'. */
function inferDtype(rows: unknown[][], colIdx: number, sample = 200): string {
  let seen = 0;
  for (let r = 0; r < rows.length && seen < sample; r++) {
    const v = rows[r]?.[colIdx];
    if (v == null || v === '') continue;
    seen++;
    if (!isNumericValue(v)) return 'string';
  }
  return seen > 0 ? 'double' : 'string';
}

/**
 * Build a `LoomDisplayPayload` (real column stats) from a Databricks command
 * table result. Returns null when there are no columns/rows to profile.
 */
export function buildDbxDataProfile(
  columns: string[] | undefined,
  rows: unknown[][] | undefined,
): LoomDisplayPayload | null {
  if (!Array.isArray(columns) || columns.length === 0 || !Array.isArray(rows)) return null;
  const fields = columns.map((name, ci) => ({ name, type: inferDtype(rows, ci) }));
  return buildLoomDisplay({ schema: { fields }, data: rows as (string | number | boolean | null)[][] });
}
