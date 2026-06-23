'use client';

/**
 * LoomChart — dependency-free SVG chart renderer for the Loom report editor.
 *
 * Handles bar, column, line, area, donut, pie, and scatter chart types from
 * AAS DAX query results (rows: Array<Record<string, unknown>>).
 *
 * Data shape (matches LoomVisual / AAS route output):
 *   rows: Array<Record<string, unknown>>
 *   – First non-numeric column → category / label axis
 *   – First numeric column    → primary value series
 *   – Additional numeric cols → extra series (line/bar multi-series)
 *
 * Design: Fluent v9 tokens for all colors / spacing, raw px only for SVG
 * geometry math. No external charting library, no dependencies beyond
 * @fluentui/react-components already installed.
 */

import { useMemo } from 'react';
import { Caption1, tokens } from '@fluentui/react-components';

// ─── Palette ────────────────────────────────────────────────────────────────
// 8 distinct brand/palette colors that are dark-mode safe (CSS variables via
// Fluent tokens resolve at render time).
const PALETTE = [
  tokens.colorBrandForeground1,
  tokens.colorPaletteGreenForeground1,
  tokens.colorPalettePurpleForeground2,
  tokens.colorPaletteMarigoldForeground1,
  tokens.colorPaletteRedForeground1,
  tokens.colorPaletteBlueForeground2,
  tokens.colorPaletteTealForeground2,
  tokens.colorPaletteBerryForeground1,
];

// Brand-fill variants for pie/donut/bar fills (slightly lighter, chart-body
// weight). Reuse palette — for fills we simply apply opacity at render time.
const FILL_OPACITY = 0.85;

// ─── Types ───────────────────────────────────────────────────────────────────

export type LoomChartType =
  | 'bar'       // horizontal bars (category on Y, value on X)
  | 'column'    // vertical bars   (category on X, value on Y)
  | 'line'      // line chart
  | 'area'      // filled area chart
  | 'donut'     // donut
  | 'pie'       // pie
  | 'scatter';  // scatter (2 numeric columns → x,y)

export interface LoomChartProps {
  type: LoomChartType;
  rows: Array<Record<string, unknown>>;
  /** Visual title shown above the chart */
  title?: string;
  /** Chart canvas height in px (default 280) */
  height?: number;
}

// ─── Data parsing ─────────────────────────────────────────────────────────

interface ParsedSeries {
  label: string;   // series name (column header)
  data: number[];  // values aligned with categories
  color: string;
}

interface ParsedData {
  categories: string[];
  series: ParsedSeries[];
  /** For scatter: first two numeric columns as x/y pairs */
  scatter?: { x: number; y: number; label: string }[];
  xLabel: string;
  yLabel: string;
}

function isNumeric(v: unknown): v is number {
  if (v == null || v === '') return false;
  return !Number.isNaN(Number(v));
}

/** Parse rows into categories + one-or-more numeric series. */
function parseRows(rows: Array<Record<string, unknown>>): ParsedData | null {
  if (rows.length === 0) return null;
  const cols = Object.keys(rows[0]);
  if (cols.length === 0) return null;

  // Identify label/category column: prefer a non-numeric column. Fall back to
  // treating the first column as a label even if it looks numeric.
  const firstNumericIdx = cols.findIndex((c) =>
    rows.some((r) => isNumeric(r[c])),
  );
  const labelCol = firstNumericIdx === 0 ? cols[0] : (cols.find((c) => rows.some((r) => !isNumeric(r[c]) && r[c] != null)) ?? cols[0]);
  const numericCols = cols.filter((c) => c !== labelCol && rows.some((r) => isNumeric(r[c])));

  if (numericCols.length === 0) return null; // no numeric data → can't chart

  const categories = rows.map((r) => (r[labelCol] == null ? '—' : String(r[labelCol])));

  const series: ParsedSeries[] = numericCols.map((col, i) => ({
    label: col,
    color: PALETTE[i % PALETTE.length],
    data: rows.map((r) => {
      const v = r[col];
      return isNumeric(v) ? Number(v) : 0;
    }),
  }));

  // Scatter: use first two numeric cols as x,y
  const scatter =
    numericCols.length >= 2
      ? rows.map((r) => ({
          x: isNumeric(r[numericCols[0]]) ? Number(r[numericCols[0]]) : 0,
          y: isNumeric(r[numericCols[1]]) ? Number(r[numericCols[1]]) : 0,
          label: r[labelCol] == null ? '—' : String(r[labelCol]),
        }))
      : rows.map((r) => ({
          x: isNumeric(r[numericCols[0]]) ? Number(r[numericCols[0]]) : 0,
          y: isNumeric(r[numericCols[0]]) ? Number(r[numericCols[0]]) : 0,
          label: r[labelCol] == null ? '—' : String(r[labelCol]),
        }));

  return {
    categories,
    series,
    scatter,
    xLabel: labelCol,
    yLabel: numericCols[0],
  };
}

// ─── Formatting helpers ───────────────────────────────────────────────────

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'M';
  if (Math.abs(v) >= 1_000) return (v / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function truncLabel(s: string, max = 12): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─── SVG layout constants ─────────────────────────────────────────────────

const W = 520; // viewBox width — scales to container via width="100%"

// ─── Sub-chart renderers ──────────────────────────────────────────────────

// Column chart (vertical bars)
function ColumnChart({ parsed, H }: { parsed: ParsedData; H: number }) {
  const padL = 52, padR = 12, padT = 12, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;

  const allVals = series.flatMap((s) => s.data);
  const rawMax = Math.max(...allVals, 0);
  const rawMin = Math.min(...allVals, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.08; // 8% head room
  const yMin = rawMin < 0 ? rawMin - span * 0.04 : 0;
  const ySpan = yMax - yMin;

  const yPix = (v: number) => padT + plotH - ((v - yMin) / ySpan) * plotH;
  const zeroY = yPix(0);

  // Group bars per category
  const groupW = plotW / n;
  const barW = (groupW * 0.7) / series.length;
  const barGap = (groupW * 0.3) / (series.length + 1);

  // 5 y-gridlines
  const gridYFractions = [0, 0.25, 0.5, 0.75, 1];

  return (
    <>
      {/* Y gridlines + labels */}
      {gridYFractions.map((f, i) => {
        const val = yMin + f * ySpan;
        const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            <line x1={padL} y1={py} x2={W - padR} y2={py}
              stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            <text x={padL - 4} y={py + 3.5} fontSize={9} textAnchor="end"
              fill={tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      {/* Zero line */}
      {rawMin < 0 && (
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY}
          stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
      )}
      {/* Axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />

      {/* Bars */}
      {categories.map((cat, ci) => {
        const gx = padL + ci * groupW;
        return series.map((sr, si) => {
          const val = sr.data[ci];
          const bx = gx + barGap * (si + 1) + barW * si;
          const by = val >= 0 ? yPix(val) : zeroY;
          const bh = Math.abs(yPix(val) - zeroY);
          return (
            <rect key={`${ci}-${si}`} x={bx} y={by} width={barW} height={Math.max(bh, 1)}
              fill={sr.color} opacity={FILL_OPACITY} rx={1.5}>
              <title>{`${sr.label} · ${cat}: ${val.toLocaleString()}`}</title>
            </rect>
          );
        });
      })}

      {/* X category labels */}
      {categories.map((cat, ci) => {
        const cx = padL + ci * groupW + groupW / 2;
        return (
          <text key={`xl${ci}`} x={cx} y={H - padB + 14} fontSize={9}
            textAnchor="middle" fill={tokens.colorNeutralForeground3}>
            {truncLabel(cat, n > 8 ? 6 : 12)}
          </text>
        );
      })}
    </>
  );
}

// Bar chart (horizontal)
function BarChart({ parsed, H }: { parsed: ParsedData; H: number }) {
  const padL = 90, padR = 36, padT = 10, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;

  const allVals = series.flatMap((s) => s.data);
  const rawMax = Math.max(...allVals, 0);
  const rawMin = Math.min(...allVals, 0);
  const span = rawMax - rawMin || 1;
  const xMax = rawMax + span * 0.08;
  const xMin = rawMin < 0 ? rawMin - span * 0.04 : 0;
  const xSpan = xMax - xMin;

  const xPix = (v: number) => padL + ((v - xMin) / xSpan) * plotW;
  const zeroX = xPix(0);

  const groupH = plotH / n;
  const barH = (groupH * 0.7) / series.length;
  const barGap = (groupH * 0.3) / (series.length + 1);

  const gridXFractions = [0, 0.25, 0.5, 0.75, 1];

  return (
    <>
      {/* X gridlines + labels */}
      {gridXFractions.map((f, i) => {
        const val = xMin + f * xSpan;
        const px = padL + f * plotW;
        return (
          <g key={`gx${i}`}>
            <line x1={px} y1={padT} x2={px} y2={padT + plotH}
              stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            <text x={px} y={H - 6} fontSize={9} textAnchor="middle"
              fill={tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      {rawMin < 0 && (
        <line x1={zeroX} y1={padT} x2={zeroX} y2={padT + plotH}
          stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
      )}
      {/* Axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />

      {/* Bars */}
      {categories.map((cat, ci) => {
        const gy = padT + ci * groupH;
        return series.map((sr, si) => {
          const val = sr.data[ci];
          const by_ = gy + barGap * (si + 1) + barH * si;
          const bx = val >= 0 ? zeroX : xPix(val);
          const bw = Math.abs(xPix(val) - zeroX);
          return (
            <rect key={`${ci}-${si}`} x={bx} y={by_} width={Math.max(bw, 1)} height={barH}
              fill={sr.color} opacity={FILL_OPACITY} rx={1.5}>
              <title>{`${sr.label} · ${cat}: ${val.toLocaleString()}`}</title>
            </rect>
          );
        });
      })}

      {/* Y category labels */}
      {categories.map((cat, ci) => {
        const cy = padT + ci * groupH + groupH / 2 + 3;
        return (
          <text key={`yl${ci}`} x={padL - 6} y={cy} fontSize={9}
            textAnchor="end" fill={tokens.colorNeutralForeground3}>
            {truncLabel(cat, 14)}
          </text>
        );
      })}
    </>
  );
}

// Line / Area chart (shared, areaFill flag)
function LineAreaChart({ parsed, H, areaFill }: { parsed: ParsedData; H: number; areaFill: boolean }) {
  const padL = 52, padR = 12, padT = 12, padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;

  const allVals = series.flatMap((s) => s.data);
  const rawMax = Math.max(...allVals, 0);
  const rawMin = Math.min(...allVals, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.1;
  const yMin = rawMin < 0 ? rawMin - span * 0.05 : 0;
  const ySpan = yMax - yMin;

  const xStep = n > 1 ? plotW / (n - 1) : 0;
  const xPix = (i: number) => padL + (n === 1 ? plotW / 2 : i * xStep);
  const yPix = (v: number) => padT + plotH - ((v - yMin) / ySpan) * plotH;
  const zeroY = yPix(0);

  const gridYFractions = [0, 0.25, 0.5, 0.75, 1];
  const gridXFractions = n <= 8
    ? categories.map((_, i) => i / Math.max(n - 1, 1))
    : [0, 0.25, 0.5, 0.75, 1];
  const gridXLabels = n <= 8
    ? categories
    : gridXFractions.map((f) => categories[Math.round(f * (n - 1))]);

  return (
    <>
      {/* Y gridlines */}
      {gridYFractions.map((f, i) => {
        const val = yMin + f * ySpan;
        const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            <line x1={padL} y1={py} x2={W - padR} y2={py}
              stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            <text x={padL - 4} y={py + 3.5} fontSize={9} textAnchor="end"
              fill={tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      {rawMin < 0 && (
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY}
          stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
      )}
      {/* Axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />

      {/* Series */}
      {series.map((sr) => {
        const pts = sr.data.map((v, i) => ({ x: xPix(i), y: yPix(v) }));
        const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const areaPath = areaFill && pts.length > 0
          ? `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${pts[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`
          : null;
        return (
          <g key={sr.label}>
            {areaPath && (
              <path d={areaPath} fill={sr.color} opacity={0.18} />
            )}
            <path d={linePath} fill="none" stroke={sr.color} strokeWidth={1.8} strokeLinejoin="round" />
            {/* Dots only when ≤ 40 points to avoid clutter */}
            {pts.length <= 40 && pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={sr.color}>
                <title>{`${sr.label} · ${categories[i]}: ${sr.data[i].toLocaleString()}`}</title>
              </circle>
            ))}
          </g>
        );
      })}

      {/* X labels */}
      {gridXFractions.map((f, i) => {
        const idx = n <= 8 ? i : Math.round(f * (n - 1));
        const px = xPix(idx);
        return (
          <text key={`xl${i}`} x={px} y={H - padB + 14} fontSize={9} textAnchor="middle"
            fill={tokens.colorNeutralForeground3}>
            {truncLabel(gridXLabels[i] ?? '', n > 6 ? 7 : 12)}
          </text>
        );
      })}
    </>
  );
}

// Pie / Donut (shared)
function PieDonutChart({ parsed, H, donut }: { parsed: ParsedData; H: number; donut: boolean }) {
  const { categories, series } = parsed;
  if (categories.length === 0 || series.length === 0) return null;

  // Only the first series is used for pie/donut
  const values = series[0].data.map((v) => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;

  const cx = W / 2, cy = H / 2 - 10;
  const radius = Math.min(cx, cy) * 0.78;
  const innerR = donut ? radius * 0.52 : 0;

  let currentAngle = -Math.PI / 2; // start at top

  const slices = values.map((v, i) => {
    const angle = (v / total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle = endAngle;

    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const xi1 = cx + innerR * Math.cos(startAngle);
    const yi1 = cy + innerR * Math.sin(startAngle);
    const xi2 = cx + innerR * Math.cos(endAngle);
    const yi2 = cy + innerR * Math.sin(endAngle);

    const large = angle > Math.PI ? 1 : 0;

    const d = donut
      ? `M${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${xi2.toFixed(2)},${yi2.toFixed(2)} A${innerR},${innerR} 0 ${large} 0 ${xi1.toFixed(2)},${yi1.toFixed(2)} Z`
      : `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;

    const midAngle = startAngle + angle / 2;
    const pct = (v / total) * 100;

    return { d, color: PALETTE[i % PALETTE.length], label: categories[i], value: v, pct, midAngle };
  });

  // Center label (donut only): total
  return (
    <>
      {slices.map((sl, i) => (
        <path key={i} d={sl.d} fill={sl.color} opacity={FILL_OPACITY} stroke={tokens.colorNeutralBackground1} strokeWidth={1.5}>
          <title>{`${sl.label}: ${sl.value.toLocaleString()} (${sl.pct.toFixed(1)}%)`}</title>
        </path>
      ))}
      {/* Percentage labels for large-enough slices */}
      {slices.map((sl, i) => {
        if (sl.pct < 5) return null;
        const labelR = donut ? (radius + innerR) / 2 : radius * 0.65;
        const lx = cx + labelR * Math.cos(sl.midAngle);
        const ly = cy + labelR * Math.sin(sl.midAngle);
        return (
          <text key={`lbl${i}`} x={lx.toFixed(1)} y={(ly + 3.5).toFixed(1)} fontSize={9.5}
            textAnchor="middle" fill="#ffffff" fontWeight="600" pointerEvents="none">
            {sl.pct.toFixed(0)}%
          </text>
        );
      })}
      {donut && (
        <>
          <text x={cx} y={cy - 3} fontSize={13} textAnchor="middle" fontWeight="700"
            fill={tokens.colorNeutralForeground1}>{fmtNum(total)}</text>
          <text x={cx} y={cy + 12} fontSize={8.5} textAnchor="middle"
            fill={tokens.colorNeutralForeground3}>Total</text>
        </>
      )}
    </>
  );
}

// Scatter chart
function ScatterChart({ parsed, H }: { parsed: ParsedData; H: number }) {
  const padL = 52, padR = 12, padT = 12, padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { scatter, series } = parsed;
  if (!scatter || scatter.length === 0) return null;

  const xs = scatter.map((p) => p.x);
  const ys = scatter.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const xPad = xSpan * 0.08, yPad = ySpan * 0.08;
  const x0 = xMin - xPad, x1 = xMax + xPad;
  const y0 = yMin - yPad, y1 = yMax + yPad;
  const xRange = x1 - x0;
  const yRange = y1 - y0;

  const xPix = (v: number) => padL + ((v - x0) / xRange) * plotW;
  const yPix = (v: number) => padT + plotH - ((v - y0) / yRange) * plotH;

  const gridFractions = [0, 0.25, 0.5, 0.75, 1];
  const color = series[0]?.color ?? PALETTE[0];

  return (
    <>
      {gridFractions.map((f, i) => {
        const xVal = x0 + f * xRange, yVal = y0 + f * yRange;
        const px = padL + f * plotW, py = padT + plotH - f * plotH;
        return (
          <g key={`g${i}`}>
            <line x1={padL} y1={py} x2={W - padR} y2={py} stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            <line x1={px} y1={padT} x2={px} y2={padT + plotH} stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            <text x={padL - 4} y={py + 3.5} fontSize={9} textAnchor="end" fill={tokens.colorNeutralForeground3}>{fmtNum(yVal)}</text>
            <text x={px} y={H - padB + 14} fontSize={9} textAnchor="middle" fill={tokens.colorNeutralForeground3}>{fmtNum(xVal)}</text>
          </g>
        );
      })}
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />

      {scatter.map((pt, i) => (
        <circle key={i} cx={xPix(pt.x)} cy={yPix(pt.y)} r={3.5}
          fill={color} opacity={FILL_OPACITY} stroke={tokens.colorNeutralBackground1} strokeWidth={0.8}>
          <title>{`${pt.label}\nx: ${pt.x.toLocaleString()}, y: ${pt.y.toLocaleString()}`}</title>
        </circle>
      ))}
    </>
  );
}

// ─── Legend strip (shared for multi-series charts) ────────────────────────

function Legend({ series }: { series: ParsedSeries[] }) {
  if (series.length <= 1) return null;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '8px',
      padding: '4px 0', marginTop: '4px',
    }}>
      {series.map((sr) => (
        <div key={sr.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: sr.color, flexShrink: 0 }} />
          <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{sr.label}</Caption1>
        </div>
      ))}
    </div>
  );
}

// Pie/Donut legend (categories)
function PieLegend({ parsed }: { parsed: ParsedData }) {
  const { categories, series } = parsed;
  if (categories.length === 0 || series.length === 0) return null;
  const values = series[0].data.map((v) => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '6px',
      padding: '4px 0', marginTop: '4px',
    }}>
      {categories.map((cat, i) => {
        const pct = (values[i] / total) * 100;
        return (
          <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{cat} ({pct.toFixed(1)}%)</Caption1>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────

/**
 * LoomChart renders an inline SVG chart from AAS DAX query rows.
 *
 * `rows` is an array of plain objects (Record<string, unknown>) as returned
 * by the AAS query route; the component auto-detects category and numeric
 * columns from the row keys.
 */
export function LoomChart({ type, rows, title, height = 280 }: LoomChartProps) {
  const parsed = useMemo(() => parseRows(rows), [rows]);

  // Empty data state
  if (!parsed) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height, border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: 6,
        color: tokens.colorNeutralForeground3, gap: 6,
      }}>
        <Caption1>No numeric data to plot.</Caption1>
      </div>
    );
  }

  // Pie/Donut height is fixed; others use the height prop
  const svgH = type === 'pie' || type === 'donut' ? Math.max(height, 240) : height;

  const renderChart = () => {
    switch (type) {
      case 'column': return <ColumnChart parsed={parsed} H={svgH} />;
      case 'bar':    return <BarChart parsed={parsed} H={svgH} />;
      case 'line':   return <LineAreaChart parsed={parsed} H={svgH} areaFill={false} />;
      case 'area':   return <LineAreaChart parsed={parsed} H={svgH} areaFill />;
      case 'donut':  return <PieDonutChart parsed={parsed} H={svgH} donut />;
      case 'pie':    return <PieDonutChart parsed={parsed} H={svgH} donut={false} />;
      case 'scatter':return <ScatterChart parsed={parsed} H={svgH} />;
      default:       return null;
    }
  };

  const isCircular = type === 'pie' || type === 'donut';

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      {title && (
        <Caption1 style={{ display: 'block', marginBottom: 4, fontWeight: tokens.fontWeightSemibold }}>
          {title}
        </Caption1>
      )}
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${svgH}`}
        role="img"
        aria-label={`${type} chart${title ? `: ${title}` : ''}`}
        style={{
          display: 'block',
          border: `1px solid ${tokens.colorNeutralStroke2}`,
          borderRadius: 6,
          background: tokens.colorNeutralBackground1,
          overflow: 'visible',
        }}
      >
        {renderChart()}
      </svg>
      {isCircular ? <PieLegend parsed={parsed} /> : <Legend series={parsed.series} />}
    </div>
  );
}
