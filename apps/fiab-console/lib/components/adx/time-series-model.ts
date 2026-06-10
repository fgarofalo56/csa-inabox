/**
 * Pure parsing model for the RTI time-series tile renderer.
 *
 * Turns a live ADX/Kusto query result (columns + rows) into an ordered X axis
 * plus a set of named numeric series, auto-detecting the two real Kusto
 * time-chart row shapes:
 *
 *   wide : [ time, valueA, valueB, … ]   (one numeric column per series)
 *   long : [ time, seriesName, value ]   (pivoted by a string name column)
 *
 * No charting deps — the SVG renderer in time-series-chart.tsx consumes this.
 * Kept dependency-free + side-effect-free so it is unit-testable in isolation.
 */

export interface SeriesPoint { t: number; label: string }
export interface Series { name: string; values: (number | null)[]; colorIdx: number }
export interface TimeSeriesModel { axis: SeriesPoint[]; series: Series[] }

export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export function isNumericColumn(rows: unknown[][], colIdx: number): boolean {
  let seen = 0;
  for (const r of rows) {
    const v = r[colIdx];
    if (v == null || v === '') continue;
    if (toNum(v) == null) return false;
    seen++;
  }
  return seen > 0;
}

/** Parse an x value into a sortable number (epoch ms for dates, else index). */
export function parseX(v: unknown, fallbackIdx: number): { t: number; label: string } {
  if (v instanceof Date) return { t: v.getTime(), label: v.toISOString() };
  if (typeof v === 'number') return { t: v, label: String(v) };
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return { t: ms, label: v };
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== '') return { t: n, label: v };
    return { t: fallbackIdx, label: v };
  }
  return { t: fallbackIdx, label: String(v ?? fallbackIdx) };
}

export function fmtVal(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

export function fmtX(label: string): string {
  const ms = Date.parse(label);
  if (!Number.isNaN(ms)) {
    const d = new Date(ms);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

/**
 * Parse a result into an ordered X axis + named numeric series. Returns null
 * when there is nothing chartable (caller falls back to a table view).
 */
export function parseSeries(columns: string[], rows: unknown[][], columnTypes?: string[]): TimeSeriesModel | null {
  if (!columns.length || !rows.length) return null;

  // X axis = first column (ADX time-chart convention: time/category leads).
  const xIdx = 0;
  const numericIdxs = columns.map((_, i) => i).filter((i) => i !== xIdx && isNumericColumn(rows, i));
  const stringIdxs = columns.map((_, i) => i).filter(
    (i) => i !== xIdx && !numericIdxs.includes(i),
  );

  // LONG layout: exactly one numeric value column + at least one string column
  // naming the series (e.g. `summarize v=avg(x) by name, bin(t)`).
  const isLong = numericIdxs.length === 1 && stringIdxs.length >= 1
    && (columnTypes?.[stringIdxs[0]] !== 'DateTime');

  if (isLong) {
    const nameIdx = stringIdxs[0];
    const valIdx = numericIdxs[0];
    const xKeys: { t: number; label: string }[] = [];
    const xPos = new Map<string, number>();
    rows.forEach((r, i) => {
      const xp = parseX(r[xIdx], i);
      if (!xPos.has(xp.label)) { xPos.set(xp.label, xKeys.length); xKeys.push(xp); }
    });
    const order = xKeys.map((_, i) => i).sort((a, b) => xKeys[a].t - xKeys[b].t);
    const sortedAxis = order.map((i) => xKeys[i]);
    const labelToSorted = new Map(sortedAxis.map((p, i) => [p.label, i]));
    const seriesMap = new Map<string, (number | null)[]>();
    rows.forEach((r) => {
      const name = String(r[nameIdx] ?? '(null)');
      const xp = parseX(r[xIdx], 0);
      const pos = labelToSorted.get(xp.label);
      if (pos == null) return;
      if (!seriesMap.has(name)) seriesMap.set(name, new Array(sortedAxis.length).fill(null));
      seriesMap.get(name)![pos] = toNum(r[valIdx]);
    });
    const series: Series[] = [...seriesMap.entries()].map(([name, values], i) => ({ name, values, colorIdx: i }));
    if (series.length === 0) return null;
    return { axis: sortedAxis.map((p) => ({ t: p.t, label: p.label })), series };
  }

  // WIDE layout: one column per series. Sort rows by parsed X.
  if (numericIdxs.length === 0) return null;
  const indexed = rows.map((r, i) => ({ r, xp: parseX(r[xIdx], i) }));
  indexed.sort((a, b) => a.xp.t - b.xp.t);
  const axis: SeriesPoint[] = indexed.map(({ xp }) => ({ t: xp.t, label: xp.label }));
  const series: Series[] = numericIdxs.map((ci, i) => ({
    name: columns[ci],
    values: indexed.map(({ r }) => toNum(r[ci])),
    colorIdx: i,
  }));
  return { axis, series };
}

/** Map the 0..1000 zoom-slider fractions to an inclusive [start,end] index window. */
export function zoomWindow(axisN: number, zoomLo: number, zoomHi: number): { start: number; end: number } {
  if (axisN <= 0) return { start: 0, end: 0 };
  const start = Math.min(axisN - 1, Math.max(0, Math.floor((zoomLo / 1000) * (axisN - 1))));
  const end = Math.max(start, Math.min(axisN - 1, Math.ceil((zoomHi / 1000) * (axisN - 1))));
  return { start, end };
}
