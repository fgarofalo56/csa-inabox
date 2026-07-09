/**
 * Eventstream live-preview shaping — PURE logic behind the docked "Data
 * preview" panel (Fabric Eventstream data-preview parity), unit-tested with no
 * DOM.
 *
 * The events route (`GET /api/items/eventstream/[id]/events`) returns REAL rows
 * peeked from the source's Event Hub, or (under private networking) the newest
 * rows the stream landed in its ADX sink — either way a list of
 * `{ partitionId?, enqueuedTime?, body }`. Fabric renders these as a table with
 * TYPE-BADGED column headers (Abc / 123 / calendar / toggle / latlong), a search
 * box, and a time-range picker. This module turns the raw rows into a typed
 * column set + flattened row records, infers each column's data type, and
 * applies the search + time-range filters — the same shaping Fabric's preview
 * grid does, computed deterministically so it can be verified in isolation.
 *
 * No mock data (no-vaporware.md): every function operates on rows the caller
 * fetched from the real backend. `shapeEventPreview([])` yields an empty shape.
 */

/** Column data types Loom badges in the preview header (Fabric parity set). */
export type PreviewColumnType = 'string' | 'number' | 'datetime' | 'boolean' | 'geo' | 'record';

export interface PreviewColumn {
  /** Row-record key + React key. */
  key: string;
  /** Inferred (or user-overridden) data type — drives the header badge. */
  type: PreviewColumnType;
  /** System columns (partition / enqueued time) render before body fields. */
  system?: boolean;
}

export interface PreviewShape {
  columns: PreviewColumn[];
  rows: Array<Record<string, unknown>>;
}

/** A raw event row as returned by the events route. */
export interface RawPreviewEvent {
  partitionId?: string | number;
  enqueuedTime?: string;
  body?: unknown;
}

/** Reserved row keys for the two system columns. */
export const SYS_PARTITION = '__partition';
export const SYS_ENQUEUED = '__enqueued';

/** Parse an event body into a flat record. Strings are JSON-parsed when they
 * decode to an object; anything else is wrapped under a single `value` field so
 * it still shows as a column rather than being dropped. */
export function coerceBody(body: unknown): Record<string, unknown> {
  let v: unknown = body;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t && (t.startsWith('{') || t.startsWith('['))) {
      try { v = JSON.parse(t); } catch { /* keep raw string */ }
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return { value: v };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const GEO_KEY_RE = /^(geo|location|coord(inate)?s?|lat[\s_-]?lon(g)?|latlong|position)$/i;

/** Whether a value looks like a lat/long geo point. */
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

/** Infer the type of a single value (ignoring null/undefined). */
export function inferValueType(v: unknown, key?: string): PreviewColumnType | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (key && GEO_KEY_RE.test(key) && isGeoValue(v)) return 'geo';
  if (isGeoValue(v)) return 'geo';
  if (typeof v === 'object') return 'record';
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 'string';
    if (ISO_DATE_RE.test(t)) return 'datetime';
    // Numeric string that isn't a leading-zero id (keep "007" as string).
    if (/^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t)) return 'number';
    return 'string';
  }
  return 'string';
}

/**
 * Infer a column's type from all its sample values. Resolution order when
 * values disagree: geo > record > datetime > boolean > number > string, i.e.
 * the most specific type that every non-null value is compatible with, falling
 * back to string on any mix that includes a plain string.
 */
export function inferColumnType(values: unknown[], key?: string): PreviewColumnType {
  const seen = new Set<PreviewColumnType>();
  for (const v of values) {
    const t = inferValueType(v, key);
    if (t) seen.add(t);
  }
  if (seen.size === 0) return 'string';
  if (seen.size === 1) return [...seen][0];
  // Mixed: numbers alongside numeric-looking becomes number only if no string.
  if (seen.has('string')) return 'string';
  if (seen.has('geo')) return 'geo';
  if (seen.has('record')) return 'record';
  if (seen.has('datetime')) return 'datetime';
  if (seen.has('number')) return 'number';
  if (seen.has('boolean')) return 'boolean';
  return 'string';
}

export interface ShapeOptions {
  /** Per-column type overrides from the header data-type dropdown. */
  typeOverrides?: Record<string, PreviewColumnType>;
}

/**
 * Turn raw events into a typed column set + flattened rows. System columns
 * (Partition / Enqueued time) come first when present, then body fields in
 * first-seen order across the batch (so the grid is stable as new fields
 * appear). Type is inferred per column, then any user override wins.
 */
export function shapeEventPreview(events: RawPreviewEvent[], opts: ShapeOptions = {}): PreviewShape {
  const overrides = opts.typeOverrides || {};
  const bodyKeys: string[] = [];
  const seenKeys = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  let anyPartition = false;
  let anyEnqueued = false;

  for (const ev of events) {
    const rec = coerceBody(ev?.body);
    const row: Record<string, unknown> = {};
    if (ev?.partitionId !== undefined && ev?.partitionId !== null && ev.partitionId !== '') {
      row[SYS_PARTITION] = ev.partitionId;
      anyPartition = true;
    }
    if (ev?.enqueuedTime) {
      row[SYS_ENQUEUED] = ev.enqueuedTime;
      anyEnqueued = true;
    }
    for (const k of Object.keys(rec)) {
      if (!seenKeys.has(k)) { seenKeys.add(k); bodyKeys.push(k); }
      row[k] = rec[k];
    }
    rows.push(row);
  }

  const columns: PreviewColumn[] = [];
  if (anyPartition) columns.push({ key: SYS_PARTITION, type: 'string', system: true });
  if (anyEnqueued) columns.push({ key: SYS_ENQUEUED, type: 'datetime', system: true });
  for (const k of bodyKeys) {
    const inferred = inferColumnType(rows.map((r) => r[k]), k);
    columns.push({ key: k, type: overrides[k] || inferred });
  }

  return { columns, rows };
}

/** Human header label for a column key (system keys get friendly names). */
export function columnLabel(key: string): string {
  if (key === SYS_PARTITION) return 'Partition';
  if (key === SYS_ENQUEUED) return 'Enqueued time';
  return key;
}

/** Render a cell value to a compact string for the grid + search. */
export function formatPreviewCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Case-insensitive substring search across every cell in a row. */
export function filterPreviewRows(
  rows: Array<Record<string, unknown>>,
  columns: PreviewColumn[],
  search: string,
): Array<Record<string, unknown>> {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    columns.some((c) => formatPreviewCell(row[c.key]).toLowerCase().includes(q)),
  );
}

/** Preset time ranges for the "Show data from" picker. `ms: null` = all time. */
export interface TimeRangeOption { id: string; label: string; ms: number | null; }
export const TIME_RANGES: TimeRangeOption[] = [
  { id: '5m', label: 'Last 5 minutes', ms: 5 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { id: 'all', label: 'All time', ms: null },
];

/**
 * Keep rows within `rangeMs` of `now` by their enqueued time. Rows with no
 * enqueued time are always kept (their age is unknown — hiding them would drop
 * real data). `rangeMs: null` keeps everything.
 */
export function filterByTimeRange(
  rows: Array<Record<string, unknown>>,
  rangeMs: number | null,
  now: number = Date.now(),
): Array<Record<string, unknown>> {
  if (rangeMs === null) return rows;
  return rows.filter((row) => {
    const raw = row[SYS_ENQUEUED];
    if (!raw) return true;
    const t = Date.parse(String(raw));
    if (Number.isNaN(t)) return true;
    return now - t <= rangeMs;
  });
}
