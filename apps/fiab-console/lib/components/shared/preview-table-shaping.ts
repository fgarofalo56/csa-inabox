/**
 * PreviewTable shaping — PURE logic behind the shared `<PreviewTable>` (SC-5),
 * the type-badged data-preview grid + timing status bar that gives every Loom
 * data surface the same Fabric-grade preview experience (Lakehouse
 * "Succeeded (3 sec 30 ms) · Columns 54 · Rows 1,000"; Eventstream
 * type-badged Data-preview).
 *
 * This module is DOM-free and unit-tested in isolation. It operates on the
 * COLUMNAR result shape every Loom data-plane route already returns —
 * `{ columns: string[], rows: unknown[][] }` (Synapse Serverless OPENROWSET for
 * Lakehouse Delta previews, dedicated-pool TDS for Warehouse query results,
 * ADX for KQL, …). No mock data (no-vaporware.md): callers pass rows they
 * fetched from the real backend; `shapeColumnarPreview([], [])` yields an empty
 * shape. Nothing here depends on Microsoft Fabric.
 */

/** Column data types Loom badges in the preview header (Fabric parity set). */
export type PreviewCellType = 'string' | 'number' | 'datetime' | 'boolean' | 'geo' | 'json';

export interface PreviewColumn {
  /** Positional index into each row array + React key. */
  index: number;
  /** Display name from the backend column list. */
  name: string;
  /** Inferred (or user-overridden) data type — drives the header badge. */
  type: PreviewCellType;
}

export interface PreviewShape {
  columns: PreviewColumn[];
}

/** Short header badge text + a11y label per type (Fabric-style Abc / 123 / …). */
export const TYPE_BADGE_TEXT: Record<PreviewCellType, { text: string; label: string }> = {
  string: { text: 'Abc', label: 'String' },
  number: { text: '123', label: 'Number' },
  datetime: { text: 'time', label: 'Datetime' },
  boolean: { text: 'bool', label: 'Boolean' },
  geo: { text: 'latlong', label: 'Geo (lat/long)' },
  json: { text: '{ }', label: 'Json' },
};

/** The type set offered in the header data-type override dropdown. */
export const PREVIEW_CELL_TYPES: PreviewCellType[] = ['string', 'number', 'datetime', 'boolean', 'geo', 'json'];

// Anchored, non-backtracking patterns (CodeQL-safe — no `\s+.*`, fully anchored).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const LEADING_ZERO_ID_RE = /^-?0\d/;
const GEO_KEY_RE = /^(geo|location|coord(inate)?s?|lat[_-]?lon(g)?|latlong|position)$/i;

/** Whether a value looks like a lat/long geo point ([lat,lon] or {lat,lon}). */
function isGeoValue(v: unknown): boolean {
  if (Array.isArray(v)) {
    return v.length === 2 && v.every((n) => typeof n === 'number');
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const hasLat = 'lat' in o || 'latitude' in o;
    const hasLon = 'lon' in o || 'lng' in o || 'longitude' in o;
    return hasLat && hasLon;
  }
  return false;
}

/** Infer the type of a single value (ignoring null/undefined → null). */
export function inferValueType(v: unknown, key?: string): PreviewCellType | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (v instanceof Date) return 'datetime';
  if (key && GEO_KEY_RE.test(key) && isGeoValue(v)) return 'geo';
  if (isGeoValue(v)) return 'geo';
  if (typeof v === 'object') return 'json';
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 'string';
    if (ISO_DATE_RE.test(t)) return 'datetime';
    // Numeric string that isn't a leading-zero id (keep "007" as a string).
    if (NUMERIC_RE.test(t) && !LEADING_ZERO_ID_RE.test(t)) return 'number';
    return 'string';
  }
  return 'string';
}

/**
 * Infer a column's type from all its sample values. When values disagree the
 * most-specific type every non-null value is compatible with wins, falling back
 * to `string` on any mix that includes a plain string.
 */
export function inferColumnType(values: unknown[], key?: string): PreviewCellType {
  const seen = new Set<PreviewCellType>();
  for (const v of values) {
    const t = inferValueType(v, key);
    if (t) seen.add(t);
  }
  if (seen.size === 0) return 'string';
  if (seen.size === 1) return [...seen][0];
  if (seen.has('string')) return 'string';
  if (seen.has('geo')) return 'geo';
  if (seen.has('json')) return 'json';
  if (seen.has('datetime')) return 'datetime';
  if (seen.has('number')) return 'number';
  if (seen.has('boolean')) return 'boolean';
  return 'string';
}

export interface ShapeOptions {
  /** Per-column type overrides from the header data-type dropdown, keyed by name. */
  typeOverrides?: Record<string, PreviewCellType>;
}

/**
 * Turn a columnar result (`columns` names + positional `rows`) into a typed
 * column set. Type is inferred per column from its values, then any user
 * override (by column name) wins. Extra column names past the row width still
 * appear (inferred as string) so schema and data never silently disagree.
 */
export function shapeColumnarPreview(
  columnNames: string[],
  rows: unknown[][],
  opts: ShapeOptions = {},
): PreviewShape {
  const overrides = opts.typeOverrides || {};
  const columns: PreviewColumn[] = columnNames.map((name, index) => {
    const inferred = inferColumnType(rows.map((r) => (Array.isArray(r) ? r[index] : undefined)), name);
    return { index, name, type: overrides[name] || inferred };
  });
  return { columns };
}

/** Render a cell value to a compact string for the grid + search. */
export function formatPreviewCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Case-insensitive substring search across every cell in each positional row. */
export function filterColumnarRows(rows: unknown[][], search: string): unknown[][] {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    Array.isArray(row) && row.some((cell) => formatPreviewCell(cell).toLowerCase().includes(q)),
  );
}

/**
 * Human-friendly elapsed-time string matching Fabric's status bar
 * ("820 ms", "3 sec 30 ms"). Negative / non-finite inputs clamp to 0 ms.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} ms`;
  const sec = Math.floor(whole / 1000);
  const rem = whole % 1000;
  return rem ? `${sec} sec ${rem} ms` : `${sec} sec`;
}

export type PreviewState = 'succeeded' | 'failed' | 'running';

export interface StatusBarParts {
  elapsedMs?: number;
  columns?: number;
  rows?: number;
  truncated?: boolean;
}

/**
 * Build the Fabric-parity preview status-bar text:
 *   "Succeeded (3 sec 30 ms) · Columns 54 · Rows 1,000".
 * `running` → "Running…"; `failed` → "Failed". Counts are locale-formatted.
 */
export function statusBarText(state: PreviewState, parts: StatusBarParts = {}): string {
  if (state === 'running') return 'Running…';
  const head = state === 'failed' ? 'Failed' : 'Succeeded';
  const segs: string[] = [];
  if (state === 'succeeded' && typeof parts.elapsedMs === 'number') {
    segs.push(`${head} (${formatElapsed(parts.elapsedMs)})`);
  } else {
    segs.push(head);
  }
  if (typeof parts.columns === 'number') segs.push(`Columns ${parts.columns.toLocaleString()}`);
  if (typeof parts.rows === 'number') {
    segs.push(`Rows ${parts.rows.toLocaleString()}${parts.truncated ? '+' : ''}`);
  }
  return segs.join(' · ');
}
