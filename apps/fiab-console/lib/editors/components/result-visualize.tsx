'use client';

/**
 * ResultVisualize — in-Loom chart visualization over a REAL query result set
 * (columns + rows from the live warehouse / SQL pool). No Power BI / Fabric
 * dependency: this is a pure responsive <svg> renderer in the same style as
 * lib/components/monitor/kql-chart.tsx, extended with the interactive
 * chart-type and axis pickers the Databricks SQL editor's "Visualization"
 * surface exposes (bar / line / area / pie / scatter).
 *
 * It is 100% client-side: the rows/columns it charts are the same real rows the
 * results grid shows. No second BFF call, no mock data.
 */

import { useMemo, useState, useEffect } from 'react';
import {
  Dropdown, Option, Field, Caption1, Text, TabList, Tab, MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'scatter';

const CHART_KINDS: { key: ChartKind; label: string }[] = [
  { key: 'bar', label: 'Bar' },
  { key: 'line', label: 'Line' },
  { key: 'area', label: 'Area' },
  { key: 'pie', label: 'Pie' },
  { key: 'scatter', label: 'Scatter' },
];

// Loom brand-leaning categorical palette (works in light + dark) — same set
// the KqlChart uses, for a consistent visual language across the product.
const SERIES_COLORS = [
  '#5b8def', '#22c1a6', '#e0a83a', '#d9534f', '#9b6bdf', '#3aa0e0', '#e07ab5', '#7bc043',
];

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '10px',
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minWidth: 0,
  },
  controls: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  picker: { minWidth: '160px' },
  legend: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' },
  legendItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: tokens.colorNeutralForeground2 },
  swatch: { width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0 },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
});

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

function label(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── geometry constants (viewBox units) ────────────────────────────────────
const W = 760;
const H = 300;
const PAD_L = 52;
const PAD_B = 40;
const PAD_T = 14;
const PAD_R = 16;

export interface ResultVisualizeProps {
  columns: string[];
  rows: unknown[][];
}

/**
 * Interactive chart panel. The user picks a chart type and the X axis +
 * Y series; the chart re-renders from the real rows. Defaults auto-suggest a
 * sensible bar chart (first categorical column on X, first numeric on Y).
 */
export function ResultVisualize({ columns, rows }: ResultVisualizeProps) {
  const s = useStyles();

  const numericIdx = useMemo(
    () => columns.map((_, i) => i).filter((i) => isNumericColumn(rows, i)),
    [columns, rows],
  );

  // Sensible defaults: X = first non-numeric column (or col 0); Y = first
  // numeric column that isn't X.
  const defaultX = useMemo(() => {
    const firstCat = columns.findIndex((_, i) => !numericIdx.includes(i));
    return firstCat >= 0 ? firstCat : 0;
  }, [columns, numericIdx]);
  const defaultY = useMemo(() => {
    const firstNum = numericIdx.find((i) => i !== defaultX);
    return firstNum ?? (numericIdx[0] ?? Math.min(1, columns.length - 1));
  }, [numericIdx, defaultX, columns.length]);

  const [kind, setKind] = useState<ChartKind>('bar');
  const [xIdx, setXIdx] = useState<number>(defaultX);
  const [yIdx, setYIdx] = useState<number>(defaultY);

  // Re-seed axes if the columns change shape (e.g. a new query result arrives).
  useEffect(() => { setXIdx(defaultX); }, [defaultX]);
  useEffect(() => { setYIdx(defaultY); }, [defaultY]);

  if (!columns.length || !rows.length) {
    return (
      <div className={s.card}>
        <MessageBar intent="info">
          <MessageBarBody>No rows to visualize. Run a query that returns rows.</MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  if (numericIdx.length === 0) {
    return (
      <div className={s.card}>
        <MessageBar intent="warning">
          <MessageBarBody>
            No numeric column in this result, so there is nothing to plot. Add an
            aggregate (e.g. <code>COUNT(*)</code>, <code>SUM(...)</code>) or a numeric
            column, then visualize.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  const yMissing = !numericIdx.includes(yIdx);
  const effectiveY = yMissing ? numericIdx[0] : yIdx;

  // Build the (x, y) data series from the chosen columns over the real rows.
  const data = rows
    .map((r) => ({ x: label(r[xIdx]), xNum: toNum(r[xIdx]), y: toNum(r[effectiveY]) }))
    .filter((d) => d.y != null) as { x: string; xNum: number | null; y: number }[];

  const seriesColor = SERIES_COLORS[effectiveY % SERIES_COLORS.length];

  return (
    <div className={s.card}>
      <TabList selectedValue={kind} onTabSelect={(_, d) => setKind(d.value as ChartKind)} size="small">
        {CHART_KINDS.map((c) => <Tab key={c.key} value={c.key}>{c.label}</Tab>)}
      </TabList>

      <div className={s.controls}>
        <Field label={kind === 'scatter' ? 'X axis (numeric)' : 'X axis (category)'} className={s.picker}>
          <Dropdown
            size="small"
            value={columns[xIdx] ?? ''}
            selectedOptions={[String(xIdx)]}
            aria-label="X axis column"
            onOptionSelect={(_, d) => setXIdx(Number(d.optionValue))}
          >
            {columns.map((c, i) => <Option key={i} value={String(i)}>{c}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Y axis (value)" className={s.picker}>
          <Dropdown
            size="small"
            value={columns[effectiveY] ?? ''}
            selectedOptions={[String(effectiveY)]}
            aria-label="Y axis column"
            onOptionSelect={(_, d) => setYIdx(Number(d.optionValue))}
          >
            {numericIdx.map((i) => <Option key={i} value={String(i)}>{columns[i]}</Option>)}
          </Dropdown>
        </Field>
      </div>

      {kind === 'pie' ? (
        <PieChartSvg data={data} valueLabel={columns[effectiveY]} />
      ) : kind === 'scatter' ? (
        <ScatterChartSvg
          rows={rows}
          xIdx={xIdx}
          yIdx={effectiveY}
          xLabel={columns[xIdx]}
          yLabel={columns[effectiveY]}
          color={seriesColor}
          xIsNumeric={numericIdx.includes(xIdx)}
        />
      ) : kind === 'bar' ? (
        <BarChartSvg data={data} valueLabel={columns[effectiveY]} color={seriesColor} />
      ) : (
        <LineAreaSvg data={data} valueLabel={columns[effectiveY]} color={seriesColor} area={kind === 'area'} />
      )}

      <Text className={s.meta}>
        {data.length} of {rows.length} rows plotted · X = {columns[xIdx]} · Y = {columns[effectiveY]}
      </Text>
    </div>
  );
}

// ── Bar (vertical) ─────────────────────────────────────────────────────────
function BarChartSvg({
  data, valueLabel, color,
}: { data: { x: string; y: number }[]; valueLabel: string; color: string }) {
  const items = data.slice(0, 40);
  if (items.length === 0) return <EmptyPlot />;
  const max = Math.max(...items.map((d) => d.y), 0);
  const min = Math.min(...items.map((d) => d.y), 0);
  const span = max - min || 1;
  const n = items.length;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const bw = Math.max(2, (plotW / n) * 0.7);
  const step = plotW / n;
  const y = (v: number) => PAD_T + (1 - (v - min) / span) * plotH;
  const zeroY = y(0);
  const tickIdx = n <= 8 ? items.map((_, i) => i) : [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Bar chart of ${valueLabel}`}>
      <GridY min={min} max={max} y={y} />
      <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
      {items.map((d, i) => {
        const cx = PAD_L + i * step + (step - bw) / 2;
        const top = y(Math.max(d.y, 0));
        const h = Math.abs(y(d.y) - zeroY);
        return <rect key={i} x={cx} y={top} width={bw} height={Math.max(h, 1)} rx={2} fill={color} opacity={0.85} />;
      })}
      {tickIdx.map((i) => (
        <text key={i} x={PAD_L + i * step + step / 2} y={H - PAD_B + 14} fontSize={10}
          fill={tokens.colorNeutralForeground3} textAnchor="middle">
          {items[i].x.length > 12 ? `${items[i].x.slice(0, 11)}…` : items[i].x}
        </text>
      ))}
    </svg>
  );
}

// ── Line / Area ─────────────────────────────────────────────────────────────
function LineAreaSvg({
  data, valueLabel, color, area,
}: { data: { x: string; y: number }[]; valueLabel: string; color: string; area: boolean }) {
  const items = data.slice(0, 500);
  if (items.length === 0) return <EmptyPlot />;
  const max = Math.max(...items.map((d) => d.y), 0);
  const min = Math.min(...items.map((d) => d.y), 0);
  const span = max - min || 1;
  const n = items.length;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_T + (1 - (v - min) / span) * plotH;

  let dPath = '';
  items.forEach((d, i) => { dPath += dPath === '' ? `M ${x(i)} ${y(d.y)}` : ` L ${x(i)} ${y(d.y)}`; });
  const areaPath = `${dPath} L ${x(n - 1)} ${y(min)} L ${x(0)} ${y(min)} Z`;
  const tickIdx = n <= 1 ? [0] : [0, Math.floor(n / 2), n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${area ? 'Area' : 'Line'} chart of ${valueLabel}`}>
      <GridY min={min} max={max} y={y} />
      {area && <path d={areaPath} fill={color} opacity={0.18} />}
      <path d={dPath} fill="none" stroke={color} strokeWidth={1.8} />
      {items.length <= 60 && items.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.y)} r={2.4} fill={color} />
      ))}
      {tickIdx.map((i) => (
        <text key={i} x={x(i)} y={H - PAD_B + 14} fontSize={10} fill={tokens.colorNeutralForeground3}
          textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
          {items[i].x.length > 14 ? `${items[i].x.slice(0, 13)}…` : items[i].x}
        </text>
      ))}
    </svg>
  );
}

// ── Scatter ─────────────────────────────────────────────────────────────────
function ScatterChartSvg({
  rows, xIdx, yIdx, xLabel, yLabel, color, xIsNumeric,
}: {
  rows: unknown[][]; xIdx: number; yIdx: number; xLabel: string; yLabel: string;
  color: string; xIsNumeric: boolean;
}) {
  // Scatter wants numeric X. If X is categorical, fall back to row-index X so
  // the plot is still meaningful (ordinal scatter).
  const pts = rows
    .map((r, i) => ({ x: xIsNumeric ? toNum(r[xIdx]) : i, y: toNum(r[yIdx]) }))
    .filter((p) => p.x != null && p.y != null) as { x: number; y: number }[];
  if (pts.length === 0) return <EmptyPlot />;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const sx = (v: number) => PAD_L + ((v - xMin) / xSpan) * plotW;
  const sy = (v: number) => PAD_T + (1 - (v - yMin) / ySpan) * plotH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Scatter of ${yLabel} vs ${xLabel}`}>
      <GridY min={yMin} max={yMax} y={sy} />
      {pts.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} fill={color} opacity={0.7} />)}
      <text x={PAD_L} y={H - 8} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="start">{fmt(xMin)}</text>
      <text x={W - PAD_R} y={H - 8} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="end">{fmt(xMax)}</text>
      <text x={(PAD_L + W - PAD_R) / 2} y={H - 8} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="middle">
        {xIsNumeric ? xLabel : `${xLabel} (row order)`}
      </text>
    </svg>
  );
}

// ── Pie ─────────────────────────────────────────────────────────────────────
function PieChartSvg({
  data, valueLabel,
}: { data: { x: string; y: number }[]; valueLabel: string }) {
  const items = data
    .map((d) => ({ label: d.x, value: Math.abs(d.y) }))
    .filter((d) => d.value > 0)
    .slice(0, 12);
  if (items.length === 0) return <EmptyPlot />;
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const cx = 150, cy = H / 2, r = Math.min(cy - PAD_T, 120);
  let angle = -Math.PI / 2;
  const slices = items.map((d, i) => {
    const frac = d.value / total;
    const a0 = angle;
    const a1 = angle + frac * 2 * Math.PI;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    return {
      path: `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      label: d.label, value: d.value, pct: (frac * 100).toFixed(1),
    };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Pie chart of ${valueLabel}`}>
      {slices.map((sl, i) => <path key={i} d={sl.path} fill={sl.color} opacity={0.88} stroke={tokens.colorNeutralBackground1} strokeWidth={1} />)}
      {slices.map((sl, i) => (
        <g key={`l${i}`}>
          <rect x={320} y={PAD_T + i * 20} width={11} height={11} rx={2} fill={sl.color} />
          <text x={338} y={PAD_T + i * 20 + 10} fontSize={11} fill={tokens.colorNeutralForeground2}>
            {(sl.label.length > 28 ? `${sl.label.slice(0, 27)}…` : sl.label)} · {fmt(sl.value)} ({sl.pct}%)
          </text>
        </g>
      ))}
    </svg>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────
function GridY({ min, max, y }: { min: number; max: number; y: (v: number) => number }) {
  const span = max - min || 1;
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const val = min + t * span;
        const yy = y(val);
        return (
          <g key={t}>
            <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={tokens.colorNeutralStroke3} strokeWidth={0.5} />
            <text x={PAD_L - 6} y={yy + 3} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="end">{fmt(val)}</text>
          </g>
        );
      })}
    </>
  );
}

function EmptyPlot() {
  return (
    <MessageBar intent="info">
      <MessageBarBody>No plottable points for the selected axes.</MessageBarBody>
    </MessageBar>
  );
}
