'use client';

/**
 * KqlChart — renders a KQL query result (columns + rows) as a chart, so the
 * Monitor → Logs library's performance/metrics/report queries draw visually
 * instead of only as a grid. No charting dependency; pure responsive <svg>,
 * matching MetricChart's lightweight Azure-portal-tile look.
 *
 *   timechart : first column = time axis, every numeric column = a line series
 *   barchart  : first column = category label, first numeric column = bar value
 *   piechart  : first column = label, first numeric column = slice value
 *
 * Defensive: if the result shape doesn't fit the requested chart (no numeric
 * column, no time column), it renders nothing and the caller falls back to the
 * data grid.
 */

import { useMemo } from 'react';
import { makeStyles, tokens, Text } from '@fluentui/react-components';

export type KqlChartType = 'timechart' | 'barchart' | 'piechart';

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '10px',
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minWidth: 0,
  },
  legend: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' },
  legendItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: tokens.colorNeutralForeground2 },
  swatch: { width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0 },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
});

// Loom brand-leaning categorical palette (works in light + dark).
const SERIES_COLORS = [
  '#5b8def', '#22c1a6', '#e0a83a', '#d9534f', '#9b6bdf', '#3aa0e0', '#e07ab5', '#7bc043',
];

function isNumericColumn(rows: unknown[][], colIdx: number): boolean {
  let seen = 0;
  for (const r of rows) {
    const v = r[colIdx];
    if (v == null || v === '') continue;
    if (typeof v === 'number') { seen++; continue; }
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) { seen++; continue; }
    return false;
  }
  return seen > 0;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

const W = 720;
const H = 220;
const PAD_L = 44;
const PAD_B = 28;
const PAD_T = 10;
const PAD_R = 12;

export function KqlChart({
  type,
  columns,
  rows,
}: {
  type: KqlChartType;
  columns: string[];
  rows: unknown[][];
}) {
  const styles = useStyles();

  const model = useMemo(() => {
    if (!columns.length || !rows.length) return null;
    // Numeric columns (skip column 0, which is the axis/label).
    const numericIdx = columns.map((_, i) => i).filter((i) => i > 0 && isNumericColumn(rows, i));
    if (numericIdx.length === 0) return null;

    if (type === 'barchart' || type === 'piechart') {
      const valIdx = numericIdx[0];
      const items = rows
        .map((r) => ({ label: String(r[0] ?? '—'), value: toNum(r[valIdx]) ?? 0 }))
        .slice(0, 20);
      return { kind: 'bars' as const, valueLabel: columns[valIdx], items };
    }

    // timechart: column 0 = time/category x-axis, numericIdx = series
    const series = numericIdx.map((i) => columns[i]);
    const points = rows.map((r) => ({
      x: String(r[0] ?? ''),
      ys: numericIdx.map((i) => toNum(r[i])),
    }));
    return { kind: 'time' as const, series, points };
  }, [type, columns, rows]);

  if (!model) return null;

  // ── Bar / pie (we render both as horizontal bars for readability) ─────────
  if (model.kind === 'bars') {
    const items = model.items;
    const max = Math.max(...items.map((d) => Math.abs(d.value)), 1);
    const rowH = 22;
    const chartH = items.length * rowH + PAD_T + 4;
    const labelW = 160;
    const barAreaW = W - labelW - 60;
    return (
      <div className={styles.card}>
        <svg viewBox={`0 0 ${W} ${chartH}`} width="100%" height={chartH} role="img" aria-label={`${model.valueLabel} by category`}>
          {items.map((d, i) => {
            const y = PAD_T + i * rowH;
            const w = (Math.abs(d.value) / max) * barAreaW;
            const color = SERIES_COLORS[i % SERIES_COLORS.length];
            return (
              <g key={i}>
                <text x={0} y={y + rowH / 2 + 4} fontSize={11} fill={tokens.colorNeutralForeground2}>
                  {d.label.length > 26 ? `${d.label.slice(0, 25)}…` : d.label}
                </text>
                <rect x={labelW} y={y + 3} width={Math.max(w, 1)} height={rowH - 8} rx={3} fill={color} opacity={0.85} />
                <text x={labelW + Math.max(w, 1) + 6} y={y + rowH / 2 + 4} fontSize={11} fill={tokens.colorNeutralForeground3}>
                  {fmt(d.value)}
                </text>
              </g>
            );
          })}
        </svg>
        <Text className={styles.meta}>{items.length} categories · value = {model.valueLabel}</Text>
      </div>
    );
  }

  // ── Time chart (multi-series line) ────────────────────────────────────────
  // model.kind === 'time' here (bars returned above).
  const { series, points } = model;
  const allVals = points.flatMap((p) => p.ys.filter((v): v is number => v != null));
  const lo = allVals.length ? Math.min(...allVals, 0) : 0;
  const hi = allVals.length ? Math.max(...allVals) : 1;
  const span = hi - lo || 1;
  const n = points.length;
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R));
  const y = (v: number) => H - PAD_B - ((v - lo) / span) * (H - PAD_B - PAD_T);

  const paths = series.map((_, sIdx) => {
    let d = '';
    points.forEach((p, i) => {
      const v = p.ys[sIdx];
      if (v == null) return;
      d += d === '' ? `M ${x(i)} ${y(v)}` : ` L ${x(i)} ${y(v)}`;
    });
    return d;
  });

  // x-axis tick labels: first, middle, last
  const tickIdx = n <= 1 ? [0] : [0, Math.floor(n / 2), n - 1];
  const shortX = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? (s.length > 10 ? `${s.slice(0, 9)}…` : s)
      : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className={styles.card}>
      <div className={styles.legend}>
        {series.map((s, i) => (
          <span key={s} className={styles.legendItem}>
            <span className={styles.swatch} style={{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {s}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="time chart">
        {/* y gridlines + labels */}
        {[0, 0.5, 1].map((t) => {
          const val = lo + t * span;
          const yy = y(val);
          return (
            <g key={t}>
              <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={tokens.colorNeutralStroke3} strokeWidth={0.5} />
              <text x={4} y={yy + 3} fontSize={10} fill={tokens.colorNeutralForeground3}>{fmt(val)}</text>
            </g>
          );
        })}
        {/* x ticks */}
        {tickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 8} fontSize={10} fill={tokens.colorNeutralForeground3}
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
            {shortX(points[i].x)}
          </text>
        ))}
        {paths.map((d, i) => (
          d ? <path key={i} d={d} fill="none" stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={1.6} /> : null
        ))}
      </svg>
      <Text className={styles.meta}>{n} points · {series.length} series</Text>
    </div>
  );
}
