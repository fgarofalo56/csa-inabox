/**
 * time-series-model — pure data-shaping for the RTI time-series chart.
 *
 * Fabric Real-Time Dashboards (and the ADX web "time chart") plot a result set
 * as one-or-more series over an X axis. The shape ADX produces from a
 * `summarize <agg> by bin(Timestamp, 1m), <SeriesCol>` query is:
 *
 *   columns = [ <x col>, <series col?>, <value col> ... ]
 *
 * where the *first datetime-ish* column is the X axis, a *string-ish* column
 * (if present) splits the rows into named series, and each *numeric* column is
 * a measure. This module turns that flat row grid into typed `Series[]` so the
 * renderer can offer legend search, pin/overlay, multi-panel, Y-axis scaling
 * and a zoom range — exactly the controls the Fabric time-series visual ships.
 *
 * It is intentionally dependency-free and side-effect-free so it can be unit
 * tested without a DOM.
 */

export interface TimePoint {
  /** Numeric X position (epoch ms for datetime, or row index / numeric value). */
  x: number;
  /** Original X label for tooltips / category axes. */
  label: string;
  /** Measured Y value. */
  y: number;
}

export interface Series {
  /** Stable key (series-column value, or measure column name when no split). */
  key: string;
  /** Human label shown in the legend. */
  name: string;
  /** Ordered points (sorted ascending by x). */
  points: TimePoint[];
}

export interface TimeSeriesShape {
  /** True when the X axis is a real datetime (epoch ms) rather than a category. */
  xIsTime: boolean;
  /** Index of the X column in the source `columns`. */
  xColIdx: number;
  /** Index of the series-splitting string column, or -1 when single-series. */
  seriesColIdx: number;
  /** Indices of numeric measure columns charted as Y. */
  valueColIdxs: number[];
  /** Built series, one per (seriesValue × measure) combination. */
  series: Series[];
  /** Min/max of all Y values across every series (for default Y scaling). */
  yMin: number;
  yMax: number;
  /** Min/max of all X positions (for the zoom range slider). */
  xMin: number;
  xMax: number;
}

const TIME_TYPE_RE = /datetime|timestamp|date|time/i;
const TIME_NAME_RE = /^(timestamp|time|date|_?bin|datetime|ts|eventtime|ingestiontime)$/i;

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse a cell as epoch-ms when it looks like a datetime, else null. */
export function parseTimeMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') {
    // Heuristic: a bare number that's plausibly epoch-ms (>= year 2001) is time.
    return v > 1_000_000_000_000 ? v : null;
  }
  const s = String(v);
  // ISO-8601 / ADX datetime renders as e.g. 2024-01-02T03:04:05.000Z.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Pick the X column: prefer a declared datetime type, then a time-ish name, then the first column. */
function pickXCol(columns: string[], columnTypes: string[] | undefined, rows: unknown[][]): { idx: number; isTime: boolean } {
  // 1. Declared datetime type from ADX columnTypes.
  if (columnTypes) {
    for (let c = 0; c < columns.length; c++) {
      if (TIME_TYPE_RE.test(columnTypes[c] || '')) return { idx: c, isTime: true };
    }
  }
  // 2. Time-ish column name.
  for (let c = 0; c < columns.length; c++) {
    if (TIME_NAME_RE.test(columns[c] || '')) return { idx: c, isTime: true };
  }
  // 3. First column whose values parse as datetime in the sample.
  for (let c = 0; c < columns.length; c++) {
    if (rows.slice(0, 8).some((r) => parseTimeMs(r[c]) !== null)) return { idx: c, isTime: true };
  }
  // 4. Fall back to the first non-numeric column as a category X.
  for (let c = 0; c < columns.length; c++) {
    if (rows.every((r) => toNum(r[c]) === null)) return { idx: c, isTime: false };
  }
  return { idx: 0, isTime: false };
}

function isStringCol(rows: unknown[][], c: number): boolean {
  // A "series" column is one whose values are categorical (non-numeric strings).
  let stringy = 0, total = 0;
  for (const r of rows.slice(0, 50)) {
    const v = r[c];
    if (v === null || v === undefined || v === '') continue;
    total++;
    if (toNum(v) === null && parseTimeMs(v) === null) stringy++;
  }
  return total > 0 && stringy / total > 0.6;
}

/**
 * Shape a flat KQL result grid into typed time series.
 *
 * Returns `null` when there is no numeric measure to chart (caller falls back
 * to the table view, matching ADX behaviour).
 */
export function buildTimeSeries(
  columns: string[],
  rows: unknown[][],
  columnTypes?: string[],
  opts?: { maxSeries?: number; maxPoints?: number },
): TimeSeriesShape | null {
  const maxSeries = opts?.maxSeries ?? 24;
  const maxPoints = opts?.maxPoints ?? 5000;
  if (!columns.length || !rows.length) return null;

  const { idx: xColIdx, isTime: xIsTime } = pickXCol(columns, columnTypes, rows);

  // Numeric measure columns (exclude the X col).
  const valueColIdxs: number[] = [];
  for (let c = 0; c < columns.length; c++) {
    if (c === xColIdx) continue;
    if (rows.some((r) => toNum(r[c]) !== null)) valueColIdxs.push(c);
  }
  if (valueColIdxs.length === 0) return null;

  // Series-splitting column: a categorical string col that is neither X nor a measure.
  let seriesColIdx = -1;
  for (let c = 0; c < columns.length; c++) {
    if (c === xColIdx || valueColIdxs.includes(c)) continue;
    if (isStringCol(rows, c)) { seriesColIdx = c; break; }
  }

  const seriesMap = new Map<string, Series>();
  const ensure = (key: string, name: string): Series => {
    let sObj = seriesMap.get(key);
    if (!sObj) { sObj = { key, name, points: [] }; seriesMap.set(key, sObj); }
    return sObj;
  };

  let rowIndex = 0;
  for (const r of rows) {
    const xRaw = r[xColIdx];
    const xMs = xIsTime ? parseTimeMs(xRaw) : null;
    const x = xMs !== null ? xMs : rowIndex;
    const label = xRaw === null || xRaw === undefined ? '' : String(xRaw);
    const splitName = seriesColIdx >= 0 ? String(r[seriesColIdx] ?? '') : '';

    for (const vc of valueColIdxs) {
      const y = toNum(r[vc]);
      if (y === null) continue;
      // Key = measure column, optionally suffixed with the split value. With a
      // single measure + a split col the legend shows just the split values
      // (ADX behaviour); with multiple measures we prefix the measure name.
      let key: string, name: string;
      if (seriesColIdx >= 0 && valueColIdxs.length > 1) {
        key = `${columns[vc]}::${splitName}`;
        name = `${columns[vc]} · ${splitName}`;
      } else if (seriesColIdx >= 0) {
        key = splitName; name = splitName || '(blank)';
      } else {
        key = columns[vc]; name = columns[vc];
      }
      ensure(key, name).points.push({ x, label, y });
    }
    rowIndex++;
  }

  // Sort each series by x and cap point count (keep newest by dropping head).
  let series = Array.from(seriesMap.values());
  for (const sObj of series) {
    sObj.points.sort((a, b) => a.x - b.x);
    if (sObj.points.length > maxPoints) sObj.points = sObj.points.slice(sObj.points.length - maxPoints);
  }
  // Cap series count, keeping the busiest series first (most points).
  series.sort((a, b) => b.points.length - a.points.length);
  if (series.length > maxSeries) series = series.slice(0, maxSeries);
  // Restore a stable, human-friendly order (alphabetical by name).
  series.sort((a, b) => a.name.localeCompare(b.name));

  let yMin = Infinity, yMax = -Infinity, xMin = Infinity, xMax = -Infinity;
  for (const sObj of series) {
    for (const p of sObj.points) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
    }
  }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; }

  return { xIsTime, xColIdx, seriesColIdx, valueColIdxs, series, yMin, yMax, xMin, xMax };
}

/** Filter series by a legend search query (case-insensitive substring). */
export function filterSeriesByQuery(series: Series[], query: string): Series[] {
  const q = query.trim().toLowerCase();
  if (!q) return series;
  return series.filter((srx) => srx.name.toLowerCase().includes(q));
}

/** Clamp a series' points to the [x0, x1] zoom window (inclusive). */
export function pointsInRange(points: TimePoint[], x0: number, x1: number): TimePoint[] {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  return points.filter((p) => p.x >= lo && p.x <= hi);
}

/** Apply Y-axis scaling. log mode clamps non-positive values to a tiny floor. */
export function scaleY(value: number, mode: 'linear' | 'log'): number {
  if (mode === 'log') return Math.log10(Math.max(value, 1e-9));
  return value;
}

/** Deterministic series color from a palette by index. */
export function seriesColor(index: number, palette: string[]): string {
  return palette[index % palette.length];
}

/** Format an epoch-ms (or numeric) X value for an axis tick / tooltip. */
export function fmtX(x: number, xIsTime: boolean): string {
  if (!xIsTime) return String(x);
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return String(x);
  // Compact ISO date+time trimmed to minutes.
  return d.toISOString().replace('T', ' ').slice(0, 16);
}
